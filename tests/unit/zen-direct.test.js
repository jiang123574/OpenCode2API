import express from 'express';
import bodyParser from 'body-parser';
import request from 'supertest';
import { jest } from '@jest/globals';
import {
    canonicalSessionId,
    ensureGateTools,
    aggregateSse,
    normalizeModelId,
    isFreeLaneModel,
    parseProxySpec,
    installZenDirectRoutes
} from '../../src/zen-direct.js';

const CANONICAL = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const bashTool = (properties) => ({
    type: 'function',
    function: { name: 'bash', description: 'run', parameters: { type: 'object', properties } }
});
const readTool = {
    type: 'function',
    function: {
        name: 'read',
        description: 'read',
        parameters: { type: 'object', properties: { file_path: { type: 'string' } } }
    }
};

describe('canonicalSessionId', () => {
    test('matches the shape the free lane accepts', () => {
        expect(canonicalSessionId('conversation-a')).toMatch(CANONICAL);
    });

    test('is stable per seed and distinct across seeds', () => {
        expect(canonicalSessionId('a')).toBe(canonicalSessionId('a'));
        expect(canonicalSessionId('a')).not.toBe(canonicalSessionId('b'));
    });

    test('encodes the inverted clock in the low 48 bits the lane decodes', () => {
        const now = 1_792_600_000_000;
        const id = canonicalSessionId('seed', now);
        const inverted = BigInt(`0x${id.slice(4, 16)}`);
        const decoded = ~inverted & 0xffffffffffffn;
        // Upstream's own encoder truncates to 48 bits; only the low 36 clock bits
        // and the 12-bit per-millisecond counter survive, and only the counter is
        // range-checked by the lane.
        expect(Number(decoded >> 12n)).toBe(Number(((BigInt(now) * 0x1000n + 1n) & 0xffffffffffffn) >> 12n));
        expect(Number(decoded & 0xfffn)).toBeLessThanOrEqual(63);
    });
});

describe('ensureGateTools', () => {
    test('leaves a client tool list that already carries bash and read untouched', () => {
        const tools = [bashTool({ command: { type: 'string' } }), readTool, { type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }];
        const out = ensureGateTools(tools, undefined, false);
        expect(out.tools).toEqual(tools);
        expect(out.injected).toEqual([]);
        expect(out.toolChoice).toBeUndefined();
    });

    test('appends only the missing gate tools, keeping client tools in place', () => {
        const tools = [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }];
        const out = ensureGateTools(tools, 'auto', false);
        expect(out.tools.map((tool) => tool.function.name)).toEqual(['web_search', 'bash', 'read']);
        expect(out.injected).toEqual(['bash', 'read']);
        expect(out.toolChoice).toBe('auto');
    });

    test('replaces a gate tool that arrives with an empty schema', () => {
        const out = ensureGateTools([bashTool({}), readTool], undefined, false);
        const bash = out.tools.find((tool) => tool.function.name === 'bash');
        expect(Object.keys(bash.function.parameters.properties).length).toBeGreaterThan(0);
        expect(out.injected).toEqual(['bash']);
    });

    test('a tools-free request gets uncallable stubs', () => {
        const out = ensureGateTools(undefined, undefined, false);
        expect(out.tools).toHaveLength(2);
        expect(out.toolChoice).toBe('none');
    });

    test('flat variant matches the Responses API shape', () => {
        const out = ensureGateTools([], undefined, true);
        expect(out.tools).toEqual([
            expect.objectContaining({ type: 'function', name: 'bash' }),
            expect.objectContaining({ type: 'function', name: 'read' })
        ]);
        expect(out.tools[0].function).toBeUndefined();
    });
});

describe('aggregateSse', () => {
    test('folds content, tool-call deltas and usage into one completion', () => {
        const sse = [
            'data: {"id":"abc","model":"m","created":1,"choices":[{"delta":{"role":"assistant","content":"hel"}}]}',
            'data: {"choices":[{"delta":{"content":"lo"}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\\"comm"}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\\":\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}',
            'data: {"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
            'data: [DONE]',
            ''
        ].join('\n');
        const out = aggregateSse(sse);
        expect(out.choices[0].message.tool_calls[0]).toEqual({
            id: 'call_1',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"ls"}' }
        });
        expect(out.choices[0].message.content).toBe('hello');
        expect(out.choices[0].finish_reason).toBe('tool_calls');
        expect(out.usage.total_tokens).toBe(7);
    });

    test('reports a plain answer without tool calls', () => {
        const out = aggregateSse('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n');
        expect(out.choices[0].message).toEqual({ role: 'assistant', content: 'hi' });
        expect(out.choices[0].finish_reason).toBe('stop');
    });
});

describe('model helpers', () => {
    test('normalizes the legacy opencode/ prefix', () => {
        expect(normalizeModelId('opencode/big-pickle')).toBe('big-pickle');
        expect(normalizeModelId('big-pickle')).toBe('big-pickle');
        expect(normalizeModelId('')).toBe('big-pickle');
    });

    test('only free-lane ids pass the catalog filter', () => {
        expect(isFreeLaneModel('deepseek-v4.1-flash-free')).toBe(true);
        expect(isFreeLaneModel('big-pickle')).toBe(true);
        expect(isFreeLaneModel('claude-opus-4-5')).toBe(false);
    });

    test('parseProxySpec parses a comma-separated list', () => {
        const proxies = parseProxySpec(' http://1.2.3.4:7890 , http://5.6.7.8:7890 ');
        expect(proxies).toHaveLength(2);
        expect(proxies[0].url).toBe('http://1.2.3.4:7890');
        expect(proxies[1].url).toBe('http://5.6.7.8:7890');
        expect(parseProxySpec('')).toEqual([]);
    });
});

describe('routes', () => {
    const buildApp = () => {
        const app = express();
        app.use(bodyParser.json());
        installZenDirectRoutes(app, { baseUrl: 'https://example.test/zen/v1', apiKey: 'public', retries: 0 });
        return app;
    };

    const sseResponse = (frames) => {
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(controller) {
                for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
            }
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('chat completions keep client tools native and reach upstream with the gate pair', async () => {
        const fetchMock = jest.fn(async (_url, init) => {
            const sent = JSON.parse(init.body);
            expect(sent.stream).toBe(true);
            expect(sent.model).toBe('deepseek-v4.1-flash-free');
            const names = sent.tools.map((tool) => tool.function.name);
            expect(names).toEqual(['web_search', 'bash', 'read']);
            return sseResponse([
                { id: 'x', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'web_search', arguments: '{"queries":["dsh"]}' } }] }, finish_reason: 'tool_calls' }] }
            ]);
        });
        global.fetch = fetchMock;

        const res = await request(buildApp())
            .post('/v1/chat/completions')
            .send({
                model: 'opencode/deepseek-v4.1-flash-free',
                stream: false,
                messages: [{ role: 'user', content: 'search dsh' }],
                tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: { queries: { type: 'array' } } } } }]
            })
            .expect(200);

        expect(res.body.choices[0].message.tool_calls[0].function.name).toBe('web_search');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // Disguise headers are what the free lane gates on.
        const headers = fetchMock.mock.calls[0][1].headers;
        expect(headers['x-opencode-session']).toMatch(CANONICAL);
        expect(headers.authorization).toBe('Bearer public');
    });

    test('surfaces a FreeTierError as a readable 403', async () => {
        global.fetch = jest.fn(async () => new Response(
            JSON.stringify({ type: 'error', error: { type: 'FreeTierError', message: 'free tier can only be used from within OpenCode' } }),
            { status: 403, headers: { 'content-type': 'application/json' } }
        ));
        const res = await request(buildApp())
            .post('/v1/chat/completions')
            .send({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] })
            .expect(403);
        expect(res.body.error.type).toBe('free_tier_gate');
    });

    test('egress proxies rotate round-robin across requests', async () => {
        const usedDispatchers = [];
        global.fetch = jest.fn(async (_url, init) => {
            usedDispatchers.push(init.dispatcher);
            return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        const proxiedApp = express();
        proxiedApp.use(bodyParser.json());
        installZenDirectRoutes(proxiedApp, {
            baseUrl: 'https://example.test/zen/v1',
            retries: 0,
            proxies: [
                { url: 'http://egress-a:7890', agent: { id: 'A' } },
                { url: 'http://egress-b:7890', agent: { id: 'B' } }
            ]
        });
        await request(proxiedApp).get('/v1/models').expect(200);
        await request(proxiedApp).get('/v1/models').expect(200);
        expect(usedDispatchers).toEqual([{ id: 'A' }, { id: 'B' }]);
    });

    test('models lists only free-lane ids and keeps the legacy prefix', async () => {
        global.fetch = jest.fn(async () => new Response(
            JSON.stringify({ object: 'list', data: [{ id: 'big-pickle' }, { id: 'glm-5.3-flash-free' }, { id: 'claude-opus-4-5' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
        ));
        const res = await request(buildApp()).get('/v1/models').expect(200);
        expect(res.body.data.map((model) => model.id)).toEqual(['opencode/big-pickle', 'opencode/glm-5.3-flash-free']);
    });
});
