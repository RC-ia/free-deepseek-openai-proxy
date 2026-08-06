// Testes unitários do roteador (router.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const routerInternals = require('../router.js').__test;

test('router: junta base URL + path sem duplicar /v1', () => {
    const url = routerInternals.joinBaseAndPath('http://127.0.0.1:9700/v1', '/v1/chat/completions');
    assert.equal(url, 'http://127.0.0.1:9700/v1/chat/completions');
});

test('router: junta base URL + path sem /v1 na base', () => {
    const url = routerInternals.joinBaseAndPath('http://127.0.0.1:9700', '/v1/chat/completions');
    assert.equal(url, 'http://127.0.0.1:9700/v1/chat/completions');
});

test('router: extrai modelo do body JSON', () => {
    assert.equal(routerInternals.extractModel('{"model":"deepseek-reasoner","messages":[]}'), 'deepseek-reasoner');
    assert.equal(routerInternals.extractModel('not json'), '');
});

test('router: pickBackend prioriza menor priority entre saudáveis', () => {
    const b1 = { id: 'a', enabled: true, alive: true, priority: 1, models: ['*'] };
    const b2 = { id: 'b', enabled: true, alive: true, priority: 2, models: ['*'] };
    const picked = routerInternals.pickBackend([b1, b2], 'priority', 'm');
    assert.equal(picked.id, 'a');
});

test('router: pickBackend pula backend morto', () => {
    const b1 = { id: 'a', enabled: true, alive: false, priority: 1, models: ['*'] };
    const b2 = { id: 'b', enabled: true, alive: true, priority: 2, models: ['*'] };
    const picked = routerInternals.pickBackend([b1, b2], 'priority', 'm');
    assert.equal(picked.id, 'b');
});

test('router: pickBackend retorna null se nenhum saudável', () => {
    const b1 = { id: 'a', enabled: true, alive: false, priority: 1, models: ['*'] };
    const picked = routerInternals.pickBackend([b1], 'priority', 'm');
    assert.equal(picked, null);
});

test('router: pickBackend respeita filtro de modelos', () => {
    const b1 = { id: 'a', enabled: true, alive: true, priority: 1, models: ['gpt-4'] };
    const b2 = { id: 'b', enabled: true, alive: true, priority: 2, models: ['*'] };
    const picked = routerInternals.pickBackend([b1, b2], 'priority', 'deepseek-reasoner');
    assert.equal(picked.id, 'b'); // b1 não suporta o modelo
});
