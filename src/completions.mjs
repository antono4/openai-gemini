// Legacy completions endpoint (text-davinci-003 style)
export async function handleLegacyCompletions(req, apiKey, {
  makeHeaders, BASE_URL, API_VERSION, DEFAULT_MODEL, transformRequest,
  transformUsage, generateId, reasonsMap, safety, fixCors, HttpError
}) {
  let model = req.model;
  switch (true) {
    case typeof model !== "string":
      throw new HttpError("model is not specified", 400);
    case model.startsWith("models/"):
      model = model.substring(7);
      break;
    case model.startsWith("gemini-"):
    case model.startsWith("gemma-"):
      break;
    default:
      model = DEFAULT_MODEL;
  }
  let isV3 = model.startsWith("gemini-3");
  
  // Transform prompt to messages format
  let prompt = req.prompt;
  if (typeof prompt === "string") {
    prompt = [{ role: "user", content: prompt }];
  } else if (Array.isArray(prompt)) {
    prompt = prompt.map((item, i) => {
      if (typeof item === "string") {
        return { role: "user", content: item };
      }
      return item;
    });
  } else {
    throw new HttpError("prompt must be a string or array", 400);
  }
  
  // Convert to chat completions format
  const chatReq = {
    ...req,
    model: req.model,
    messages: prompt,
  };
  
  let body = await transformRequest(chatReq, isV3);
  const extra = req.extra_body?.google;
  if (extra) {
    if (extra.safety_settings) {
      body.safetySettings = extra.safety_settings;
    }
    if (extra.cached_content) {
      body.cachedContent = extra.cached_content;
    }
    if (extra.thinking_config) {
      body.generationConfig.thinkingConfig = extra.thinking_config;
    }
  }
  
  // Handle suffix for completion (Gemini doesn't support this directly)
  if (req.suffix) {
    console.warn("suffix parameter is not supported by Gemini, ignoring");
  }
  
  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) { url += "?alt=sse"; }
  const response = await fetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  body = response.body;
  if (response.ok) {
    let id = "cmpl-" + generateId();
    const shared = {};
    if (req.stream) {
      body = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
          shared,
        }))
        .pipeThrough(new TransformStream({
          transform: toLegacyOpenAiStream,
          flush: toLegacyOpenAiStreamFlush,
          streamIncludeUsage: req.stream_options?.include_usage,
          model, id, last: {},
          shared,
        }))
        .pipeThrough(new TextEncoderStream());
    } else {
      body = await response.text();
      try {
        body = JSON.parse(body);
        if (!body.candidates) {
          throw new Error("Invalid completion object");
        }
      } catch (err) {
        console.error("Error parsing response:", err);
        return new Response(body, fixCors(response));
      }
      body = processLegacyCompletionsResponse(body, model, id, req);
    }
  }
  return new Response(body, fixCors(response));
}

function processLegacyCompletionsResponse(data, model, id, req) {
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const obj = {
    id,
    choices: [{
      text,
      index: 0,
      logprobs: null,
      finish_reason: reasonsMap[data.candidates?.[0]?.finishReason] ?? data.candidates?.[0]?.finishReason,
    }],
    created: Math.floor(Date.now()/1000),
    model: data.modelVersion ?? model,
    object: "text_completion",
    usage: data.usageMetadata && transformUsage(data.usageMetadata),
  };
  return JSON.stringify(obj);
}

const delimiter = "\n\n";
const sseline = (obj) => {
  obj.created = Math.floor(Date.now()/1000);
  return "data: " + JSON.stringify(obj) + delimiter;
};

function toLegacyOpenAiStream(line, controller) {
  let data;
  try {
    data = JSON.parse(line);
    if (!data.candidates) {
      throw new Error("Invalid completion chunk object");
    }
  } catch (err) {
    console.error("Error parsing response:", err);
    if (!this.shared.is_buffers_rest) { line =+ "\n\n"; }
    controller.enqueue(line);
    return;
  }
  let obj;
  try {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const prevText = this.last[this.id] || "";
    obj = {
      id: data.responseId ?? this.id,
      choices: [{
        text: text.substring(prevText.length),
        index: 0,
        logprobs: null,
        finish_reason: null,
      }],
      created: Math.floor(Date.now()/1000),
      model: data.modelVersion ?? this.model,
      object: "text_completion.chunk",
      usage: data.usageMetadata && this.streamIncludeUsage ? null : undefined,
    };
  } catch (err) {
    console.error(err);
    controller.enqueue("Unexpected error while handling request: " + err.message);
    controller.enqueue("\n\n" + line);
    controller.terminate();
    return;
  }
  if (data.promptFeedback?.blockReason) {
    console.log("Prompt block reason:", data.promptFeedback.blockReason);
    controller.enqueue("data: " + JSON.stringify(obj) + "\n\n");
    return;
  }
  this.last[this.id] = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  controller.enqueue("data: " + JSON.stringify(obj) + "\n\n");
  if (data.usageMetadata && this.streamIncludeUsage) {
    obj.choices = [];
    obj.usage = transformUsage(data.usageMetadata);
    controller.enqueue("data: " + JSON.stringify(obj) + delimiter);
  }
}

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
function parseStream(chunk, controller) {
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true);
}
function parseStreamFlush(controller) {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
    this.shared.is_buffers_rest = true;
  }
}
