import http from 'node:http';
import https from 'node:https';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { afterAll, beforeAll } from 'vitest';

const blockedPeopleSoftHost = 'sis.auib.edu.iq';
const originalFetch = globalThis.fetch;
const originalHttpRequest = http.request;
const originalHttpGet = http.get;
const originalHttpsRequest = https.request;
const originalHttpsGet = https.get;
let originalDispatcher: Dispatcher;
let mockAgent: MockAgent;

function rejectDirectNetwork(): never {
  throw new Error('Direct HTTP network access is disabled in tests');
}

beforeAll(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  http.request = rejectDirectNetwork;
  http.get = rejectDirectNetwork;
  https.request = rejectDirectNetwork;
  https.get = rejectDirectNetwork;

  globalThis.fetch = (input, init) => {
    const rawUrl = input instanceof Request ? input.url : input.toString();
    const url = new URL(rawUrl);

    if (url.hostname.toLowerCase() === blockedPeopleSoftHost) {
      return Promise.reject(
        new Error(`Network access to ${blockedPeopleSoftHost} is blocked in tests`),
      );
    }

    return originalFetch(input, init);
  };
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  http.request = originalHttpRequest;
  http.get = originalHttpGet;
  https.request = originalHttpsRequest;
  https.get = originalHttpsGet;
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});
