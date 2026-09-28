// audio.test.js — the audio front end: 24 kHz → 16 kHz resampling, loudness, and the WAV
// wrapper Whisper receives.
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { __test: a } = require('../src/utils/localai');

function sine(hz, seconds, rate, amp = 0.5) {
    const n = Math.round(seconds * rate);
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp * 32767), i * 2);
    return buf;
}

test('resampling keeps 2 of every 3 samples, across chunk boundaries', () => {
    // 1 s of 24 kHz audio fed in 7 odd-sized chunks comes out as 1 s of 16 kHz audio
    const input = sine(440, 1, 24000);
    let out = 0;
    for (let i = 0; i < input.length; i += 6858) out += a.resample24kTo16k(input.slice(i, i + 6858)).length / 2;
    assert.ok(Math.abs(out - 16000) <= 2, `got ${out} samples`);
});

test('resampling preserves the tone (same loudness in, same loudness out)', () => {
    const inRms = a.calculateRms(sine(440, 0.5, 24000));
    const outRms = a.calculateRms(a.resample24kTo16k(sine(440, 0.5, 24000)));
    assert.ok(Math.abs(inRms - outRms) < 0.01, `${inRms} vs ${outRms}`);
});

test('loudness: silence is 0, a half-scale sine is ~0.354, an empty buffer is 0', () => {
    assert.equal(a.calculateRms(Buffer.alloc(3200)), 0);
    assert.ok(Math.abs(a.calculateRms(sine(440, 0.1, 16000)) - 0.5 / Math.SQRT2) < 0.005);
    assert.equal(a.calculateRms(Buffer.alloc(0)), 0);
});

test('the WAV wrapper is a valid 16 kHz mono 16-bit file', () => {
    const pcm = sine(440, 0.25, 16000);
    const wav = a.createWavBuffer(pcm);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 1, 'mono');
    assert.equal(wav.readUInt32LE(24), 16000, 'sample rate');
    assert.equal(wav.readUInt16LE(34), 16, 'bits');
    assert.equal(wav.readUInt32LE(40), pcm.length, 'data size');
    assert.equal(wav.readUInt32LE(4), wav.length - 8, 'riff size');
});
