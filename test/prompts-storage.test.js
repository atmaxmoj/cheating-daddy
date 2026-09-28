// prompts-storage.test.js — the cue prompt carries its rules and the context, and a fresh
// install starts on DeepSeek + Cue Cards (no Gemini, no onboarding).
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { getSystemPrompt } = require('../src/utils/prompts');
const storage = require('../src/storage');

test('the cue prompt states the card format and carries the notes it was given', () => {
    const p = getSystemPrompt('cues', '# Your projects\n- standmeet: self-hosted page', false);
    for (const rule of ['Key', 'Example', 'From', 'OWN projects']) assert.ok(p.includes(rule), `missing ${rule}`);
    assert.ok(p.includes('- standmeet: self-hosted page'));
    assert.ok(!/google search/i.test(p), 'search usage stays out when search is off');
});

test('a fresh install: DeepSeek flash, base.en Whisper, Cue Cards, onboarded', () => {
    storage.initializeStorage();
    const prefs = storage.getPreferences();
    assert.equal(prefs.providerMode, 'local');
    assert.equal(prefs.localLlmModel, 'deepseek:deepseek-flash');
    assert.equal(prefs.whisperModel, 'base.en');
    assert.equal(prefs.selectedProfile, 'cues');
    assert.equal(storage.getConfig().onboarded, true);
});

test('credentials round-trip and stay out of preferences', () => {
    storage.setCredentials({ deepseekApiKey: 'sk-test' });
    assert.equal(storage.getCredentials().deepseekApiKey, 'sk-test');
    assert.ok(!JSON.stringify(storage.getPreferences()).includes('sk-test'));
});
