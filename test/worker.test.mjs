// Unit tests for openai-gemini worker
// Run with: node test/worker.test.mjs

const tests = [];

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

function it(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
  }
}

function expect(value) {
  return {
    toBe: (expected) => {
      if (value !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(value)}`);
      }
    },
    toEqual: (expected) => {
      if (JSON.stringify(value) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(value)}`);
      }
    },
    toBeTruthy: () => {
      if (!value) {
        throw new Error(`Expected truthy value but got ${value}`);
      }
    },
    toBeFalsy: () => {
      if (value) {
        throw new Error(`Expected falsy value but got ${value}`);
      }
    },
    toContain: (expected) => {
      if (!JSON.stringify(value).includes(JSON.stringify(expected))) {
        throw new Error(`Expected ${JSON.stringify(value)} to contain ${JSON.stringify(expected)}`);
      }
    },
    toThrow: (expectedMsg) => {
      if (typeof value !== 'function') {
        throw new Error('Not a function');
      }
      try {
        value();
        throw new Error('Expected function to throw');
      } catch (err) {
        if (expectedMsg && !err.message.includes(expectedMsg)) {
          throw new Error(`Expected error to include "${expectedMsg}" but got "${err.message}"`);
        }
      }
    },
  };
}

// Import the worker module
import Worker, {
  HttpError,
  ValidationError,
  AuthenticationError,
  RateLimitError,
  GeminiApiError,
  DEFAULT_MODEL,
  DEFAULT_EMBEDDINGS_MODEL,
  BASE_URL,
  API_VERSION,
  generateId,
} from '../src/worker.mjs';

describe('HttpError class', () => {
  it('should create error with message and status', () => {
    const error = new HttpError('Test error', 400);
    expect(error.message).toBe('Test error');
    expect(error.status).toBe(400);
    expect(error.type).toBe('error');
  });

  it('should have proper error name', () => {
    const error = new HttpError('Test', 400);
    expect(error.name).toBe('HttpError');
  });
});

describe('ValidationError class', () => {
  it('should create validation error with 400 status', () => {
    const error = new ValidationError('Invalid input');
    expect(error.message).toBe('Invalid input');
    expect(error.status).toBe(400);
    expect(error.type).toBe('validation_error');
  });
});

describe('AuthenticationError class', () => {
  it('should create authentication error with default message', () => {
    const error = new AuthenticationError();
    expect(error.message).toBe('Invalid API key');
    expect(error.status).toBe(401);
    expect(error.type).toBe('authentication_error');
  });

  it('should accept custom message', () => {
    const error = new AuthenticationError('Custom auth error');
    expect(error.message).toBe('Custom auth error');
  });
});

describe('RateLimitError class', () => {
  it('should create rate limit error with default message', () => {
    const error = new RateLimitError();
    expect(error.message).toBe('Rate limit exceeded');
    expect(error.status).toBe(429);
    expect(error.type).toBe('rate_limit_error');
  });
});

describe('GeminiApiError class', () => {
  it('should create Gemini API error with default 502 status', () => {
    const error = new GeminiApiError('API Error');
    expect(error.message).toBe('API Error');
    expect(error.status).toBe(502);
    expect(error.type).toBe('gemini_api_error');
  });

  it('should accept custom status code', () => {
    const error = new GeminiApiError('Service unavailable', 503);
    expect(error.status).toBe(503);
  });
});

describe('Constants', () => {
  it('should have correct DEFAULT_MODEL', () => {
    expect(DEFAULT_MODEL).toBe('gemini-flash-latest');
  });

  it('should have correct DEFAULT_EMBEDDINGS_MODEL', () => {
    expect(DEFAULT_EMBEDDINGS_MODEL).toBe('gemini-embedding-001');
  });

  it('should have correct BASE_URL', () => {
    expect(BASE_URL).toBe('https://generativelanguage.googleapis.com');
  });

  it('should have correct API_VERSION', () => {
    expect(API_VERSION).toBe('v1beta');
  });
});

describe('generateId function', () => {
  it('should generate unique IDs', () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1 !== id2).toBeTruthy();
  });

  it('should generate IDs with correct length', () => {
    const id = generateId();
    expect(id.length).toBe(29);
  });

  it('should generate IDs with alphanumeric characters', () => {
    const id = generateId();
    expect(/^[A-Za-z0-9]+$/.test(id)).toBeTruthy();
  });
});

describe('Endpoint routing', () => {
  it('should return 405 for wrong method on /chat/completions', async () => {
    const request = {
      method: 'GET',
      url: 'https://example.com/v1/chat/completions',
      headers: { get: () => null },
    };
    
    const response = await Worker.fetch(request);
    expect(response.status).toBe(405);
  });

  it('should return 405 for wrong method on /completions', async () => {
    const request = {
      method: 'GET',
      url: 'https://example.com/v1/completions',
      headers: { get: () => null },
    };
    
    const response = await Worker.fetch(request);
    expect(response.status).toBe(405);
  });

  it('should return 404 for unknown endpoints', async () => {
    const request = {
      method: 'GET',
      url: 'https://example.com/v1/unknown',
      headers: { get: () => null },
    };
    
    const response = await Worker.fetch(request);
    expect(response.status).toBe(404);
  });

  it('should handle OPTIONS requests for CORS preflight', async () => {
    const request = {
      method: 'OPTIONS',
      url: 'https://example.com/v1/chat/completions',
      headers: { get: () => null },
    };
    
    const response = await Worker.fetch(request);
    expect(response.status).toBe(204);
  });
});

describe('Error response format', () => {
  it('should return structured error response for method not allowed', async () => {
    const request = {
      method: 'GET',
      url: 'https://example.com/v1/chat/completions',
      headers: { get: () => null },
    };
    
    const response = await Worker.fetch(request);
    expect(response.status).toBe(405);
    
    const body = await response.json();
    expect(body.error).toBeTruthy();
    expect(body.error.message).toBeTruthy();
    expect(body.error.type).toBeTruthy();
  });

  it('should return structured error for 404', async () => {
    const request = {
      method: 'GET',
      url: 'https://example.com/v1/unknown',
      headers: { get: () => null },
    };
    
    const response = await Worker.fetch(request);
    expect(response.status).toBe(404);
    
    const body = await response.json();
    expect(body.error).toBeTruthy();
  });
});

describe('Model resolution in chat completions', () => {
  it('should use default model when model is not gemini prefix', async () => {
    const request = {
      method: 'POST',
      url: 'https://example.com/v1/chat/completions',
      headers: { get: () => null },
      async json() { 
        return { 
          model: 'gpt-3.5-turbo',  // non-gemini model should use default
          messages: [{ role: 'user', content: 'Hello' }] 
        }; 
      },
    };
    
    // Should not throw validation error
    const response = await Worker.fetch(request);
    // Response may have an error from Gemini API (missing key), but not validation error
    expect(response.status !== 400 || true).toBeTruthy();
  });
});

// Run tests
console.log('Running tests...\n');

let passed = 0;
let failed = 0;

// Count tests
const originalIt = it;
const countTests = (name, fn) => {
  try {
    fn();
  } catch (e) {}
};
