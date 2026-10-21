const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn, saveTranscriptLine } = require('./gemini');
const { call, publishTranscript, publishSaid, newCueID, startPulling, stopPulling } = require('./feed');
const { getCredentials, getPreferences } = require('../storage');
const {
    ensureNativeBinary,
    ensureLlamaModel,
    ensureWhisperModel,
    getAvailablePort,
    getModelsDirectory,
    startNativeServer,
    stopNativeServer,
    waitForServer,
} = require('./native-ai-runtime');

let llamaProcess = null;
let llamaBaseUrl = null;
let llamaModel = null;
let whisperProcess = null;
let whisperBaseUrl = null;
let localConversationHistory = [];
let currentSystemPrompt = null;
let currentProfile = null;
let currentCustomPrompt = '';

// cueSession — the Cue Cards profile's session with StandMeet: the role (none = every wiki note),
// one call id for the whole interview (the server keeps the conversation and the job a phone
// screen locks onto), and the names for Whisper's prompt. Every other profile keeps the fixed
// prompt built at session start and its own model.
let cueSession = null;
let isLocalActive = false;
let initializationController = null;
let llamaCacheSnapshot = new Set();

// Two streams, each with its own voice detection: "them" is the computer's audio (the other side —
// transcribed, then cued), "me" is the microphone (the owner — transcribed for the record only).
// Mixing them into one detector let the owner's voice cut the other side's question.
function newStream() {
    return {
        isSpeaking: false,
        speechBuffers: [],
        silenceFrameCount: 0,
        speechFrameCount: 0,
        voicedFrameCount: 0, // loud frames in the current turn (the buffer also holds its silences)
        resampleRemainder: Buffer.alloc(0),
    };
}
let streams = { them: newStream(), me: newStream() };
const MIN_VOICED_FRAMES = 5; // ~0.5 s of actual speech before a turn is worth transcribing
let whisperQueue = Promise.resolve(); // one Whisper server, one request at a time

// Whisper writes these for audio without words ("[BLANK_AUDIO]", "(coughs)", "[Music]").
const NON_SPEECH = /^[\s[(*].*[\])*]\s*$/;

const VAD_MODES = {
    NORMAL: { energyThreshold: 0.01, speechFramesRequired: 3, silenceFramesRequired: 30 },
    LOW_BITRATE: { energyThreshold: 0.008, speechFramesRequired: 4, silenceFramesRequired: 35 },
    AGGRESSIVE: { energyThreshold: 0.015, speechFramesRequired: 2, silenceFramesRequired: 20 },
    VERY_AGGRESSIVE: { energyThreshold: 0.02, speechFramesRequired: 2, silenceFramesRequired: 15 },
};

let vadConfig = VAD_MODES.VERY_AGGRESSIVE;

// A model id "deepseek:<model>" keeps local Whisper for transcription and sends replies to the
// DeepSeek API (OpenAI-compatible, the same stream format as llama-server): no llama runner, no
// model download. Thinking is off: a cue has to land within a second (measured 2026-09-27:
// deepseek-flash, first token 0.8 s with thinking disabled, 3 s of reasoning otherwise).
const API_PREFIX = 'deepseek:';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

function isApiModel(model) {
    return typeof model === 'string' && model.startsWith(API_PREFIX);
}

async function requestDeepSeek(messages, onText) {
    const apiKey = getCredentials().deepseekApiKey;
    if (!apiKey) throw new Error('DeepSeek API key is not set');
    const response = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: llamaModel.slice(API_PREFIX.length),
            messages,
            stream: true,
            max_tokens: 800,
            thinking: { type: 'disabled' },
        }),
    });
    if (!response.ok || !response.body) {
        throw new Error(`DeepSeek returned HTTP ${response.status}: ${await response.text()}`);
    }
    return readStreamingResponse(response, onText);
}
function resample24kTo16k(stream, inputBuffer) {
    const combined = Buffer.concat([stream.resampleRemainder, inputBuffer]);
    const inputSamples = Math.floor(combined.length / 2);
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const sourcePosition = (i * 3) / 2;
        const sourceIndex = Math.floor(sourcePosition);
        const fraction = sourcePosition - sourceIndex;
        const firstSample = combined.readInt16LE(sourceIndex * 2);
        const secondSample = sourceIndex + 1 < inputSamples ? combined.readInt16LE((sourceIndex + 1) * 2) : firstSample;
        const interpolated = Math.round(firstSample + fraction * (secondSample - firstSample));
        outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }

    const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
    const remainderStart = consumedInputSamples * 2;
    stream.resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

    return outputBuffer;
}

function calculateRms(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
}

// Audio level, logged every 5 s: "is sound reaching the assistant at all" is the first question
// when no cue appears, and the answer should not need a debugger.
// Per stream: "is the microphone reaching it" is a separate question from the computer audio.
function logLevel(source, s, rms) {
    s.levelPeak = Math.max(s.levelPeak || 0, rms);
    const now = Date.now();
    if (now - (s.levelLoggedAt || 0) < 5000) return;
    console.log(`[LocalAI] ${source} audio level peak ${s.levelPeak.toFixed(4)} (speech threshold ${vadConfig.energyThreshold})`);
    s.levelPeak = 0;
    s.levelLoggedAt = now;
}

function processVad(source, s, pcm16kBuffer) {
    const rms = calculateRms(pcm16kBuffer);
    logLevel(source, s, rms);
    const isVoice = rms > vadConfig.energyThreshold;

    if (isVoice) {
        s.speechFrameCount += 1;
        s.silenceFrameCount = 0;
        if (s.isSpeaking) s.voicedFrameCount += 1;

        if (!s.isSpeaking && s.speechFrameCount >= vadConfig.speechFramesRequired) {
            s.isSpeaking = true;
            s.speechBuffers = [];
            s.voicedFrameCount = 1;
            console.log(`[LocalAI] Speech started (${source}, RMS:`, rms.toFixed(4), ')');
            if (source === 'them') sendToRenderer('update-status', 'Listening... (speech detected)');
        }
    } else {
        s.silenceFrameCount += 1;
        s.speechFrameCount = 0;

        if (s.isSpeaking && s.silenceFrameCount >= vadConfig.silenceFramesRequired) {
            s.isSpeaking = false;
            const audioData = Buffer.concat(s.speechBuffers);
            s.speechBuffers = [];
            // The buffer also holds the silence that ended the turn, so its length says nothing
            // about how much was said: a cough plus 1.5 s of quiet looked like a question.
            if (s.voicedFrameCount < MIN_VOICED_FRAMES) {
                console.log(`[LocalAI] Too little speech (${source}), skipping (`, s.voicedFrameCount, 'voiced frames )');
                return;
            }
            console.log(`[LocalAI] Speech ended (${source}), accumulated`, audioData.length, 'bytes');
            handleSpeechEnd(source, audioData);
            return;
        }
    }

    if (s.isSpeaking) {
        s.speechBuffers.push(Buffer.from(pcm16kBuffer));
    }
}

function createWavBuffer(pcm16Buffer) {
    const header = Buffer.alloc(44);
    const byteRate = 16000 * 2;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm16Buffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm16Buffer.length, 40);

    return Buffer.concat([header, pcm16Buffer]);
}

async function transcribeAudio(pcm16kBuffer) {
    if (!whisperBaseUrl) {
        throw new Error('Whisper server is not running');
    }

    const wavBuffer = createWavBuffer(pcm16kBuffer);
    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
    formData.append('response_format', 'json');
    formData.append('temperature', '0.0');
    formData.append('language', 'en');
    // The user's own names (projects, stack, companies — assistant.prepare) bias Whisper toward
    // their spelling ("StandMeet", not "stand meet"; "bwrap", not "BRAP").
    const hint = cueSession?.hint;
    if (hint) formData.append('prompt', `Interview about ${hint}.`);

    const response = await fetch(`${whisperBaseUrl}/inference`, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`Whisper server returned HTTP ${response.status}`);
    }

    const result = await response.json();
    const text = result.text?.trim() || '';
    console.log('[LocalAI] Transcription:', text);
    return text;
}

// handleSpeechEnd — transcribes one turn. Both sides go into the transcript; only the other side's
// turn goes on to the model, the cue and the phone feed. The owner's own words are kept for review.
async function handleSpeechEnd(source, audioData) {
    if (!isLocalActive) return;

    if (audioData.length < 16000) {
        console.log(`[LocalAI] Audio too short (${source}), skipping`);
        return;
    }

    try {
        if (source === 'them') sendToRenderer('update-status', 'Transcribing...');
        const transcribed = whisperQueue.then(() => transcribeAudio(audioData));
        whisperQueue = transcribed.catch(() => {});
        const transcription = await transcribed;

        if (!transcription || transcription.length < 2 || NON_SPEECH.test(transcription)) {
            console.log(`[LocalAI] Empty transcription (${source}), skipping`);
            if (source === 'them') sendToRenderer('update-status', 'Listening...');
            return;
        }

        if (source === 'me') publishSaid(transcription);
        else publishTranscript(transcription);
        await takeLine(source, transcription);
    } catch (error) {
        console.error('[LocalAI] Transcription error:', error);
        sendToRenderer('update-status', 'Transcription error: ' + error.message);
    }
}

// takeLine — one line of the conversation, heard or pulled from the feed: into the transcript, and
// the other side's line on to the model for a cue. The owner's own line is kept for review only.
async function takeLine(source, text) {
    const line = { text, source, at: Date.now() };
    sendToRenderer('transcript-line', line);
    saveTranscriptLine(line);
    if (source === 'me') return;
    sendToRenderer('update-status', 'Generating response...');
    await sendToLlama(text);
}

// takeFeedEvent — from the feed: a card (growing under its id — this app's or another agent's
// ask), or a line another agent pushed (a mock interview): its question is "them", its record of
// the owner's answer is "me".
function takeFeedEvent(e) {
    if (!isLocalActive) return;
    if (e.kind === 'cue') return showCue(e.id, e.text);
    takeLine(e.kind === 'said' ? 'me' : 'them', e.text).catch(error => console.error('[LocalAI] feed line:', error.message));
}

// showCue — a card on screen: a new id starts a new card, the same id grows it.
let shownCue = null;
function showCue(id, text) {
    if (!text) return;
    sendToRenderer(id === shownCue ? 'update-response' : 'new-response', text);
    shownCue = id;
}

// cueOnServer — the card for the other side's line, made by StandMeet from the role's notes; it
// streams into the feed (startPulling shows it as it grows) and comes back whole.
async function cueOnServer(line) {
    const id = newCueID();
    const ask = { question: line, round: getPreferences().interviewRound || 'general', call_id: cueSession.callId, id };
    if (cueSession.roleId) ask.role_id = cueSession.roleId;
    if (currentCustomPrompt.trim()) ask.user_context = currentCustomPrompt.trim();
    try {
        const { card } = await call('assistant.cue', ask);
        showCue(id, card);
        saveConversationTurn(line, card);
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('[LocalAI] cue:', error);
        sendToRenderer('update-status', 'Cue error: ' + error.message.replace(/^StandMeet [\w.]+: /, ''));
        throw error;
    }
}

async function readStreamingResponse(response, onText) {
    const decoder = new TextDecoder();
    let pendingText = '';
    let fullText = '';

    for await (const chunk of response.body) {
        pendingText += decoder.decode(chunk, { stream: true });
        const lines = pendingText.split('\n');
        pendingText = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            const event = JSON.parse(data);
            const token = event.choices?.[0]?.delta?.content || '';
            if (!token) continue;

            fullText += token;
            onText(fullText);
        }
    }

    return fullText;
}

async function requestLlama(messages, onText) {
    if (isApiModel(llamaModel)) {
        return requestDeepSeek(messages, onText);
    }
    if (!llamaBaseUrl) {
        throw new Error('Llama server is not running');
    }

    const response = await fetch(`${llamaBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'local',
            messages,
            stream: true,
            max_tokens: 2048,
            chat_template_kwargs: {
                enable_thinking: false,
            },
        }),
    });

    if (!response.ok || !response.body) {
        const errorText = await response.text();
        throw new Error(`Llama server returned HTTP ${response.status}: ${errorText}`);
    }

    return readStreamingResponse(response, onText);
}

async function sendToLlama(transcription) {
    if (cueSession) return cueOnServer(transcription.trim());
    localConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (localConversationHistory.length > 20) {
        localConversationHistory = localConversationHistory.slice(-20);
    }

    try {
        const system = currentSystemPrompt || 'You are a helpful assistant.';
        const messages = [{ role: 'system', content: system }, ...localConversationHistory];

        let isFirst = true;
        const fullText = await requestLlama(messages, text => {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            isFirst = false;
        });

        if (fullText.trim()) {
            localConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });
            saveConversationTurn(transcription, fullText);
        }

        console.log('[LocalAI] Llama response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('[LocalAI] Llama error:', error);
        sendToRenderer('update-status', 'Local AI error: ' + error.message);
        throw error;
    }
}

function formatDownloadStatus(label, progress) {
    if (!progress.expectedBytes) {
        return `Downloading ${label}...`;
    }

    const percentage = Math.floor((progress.downloadedBytes / progress.expectedBytes) * 100);
    return `Downloading ${label}... ${percentage}%`;
}

function sendDownloadProgress(label, progress = null) {
    const percentage = progress?.expectedBytes ? Math.min(100, Math.floor((progress.downloadedBytes / progress.expectedBytes) * 100)) : null;
    sendToRenderer('local-ai-download-progress', {
        active: true,
        label,
        percentage,
    });
}

function getDirectoryEntries(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return new Set();
    }

    const entries = new Set();
    const visit = currentPath => {
        for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
            const entryPath = path.join(currentPath, entry.name);
            entries.add(entryPath);
            if (entry.isDirectory()) {
                visit(entryPath);
            }
        }
    };

    visit(directoryPath);
    return entries;
}

function removeNewLlamaCacheEntries() {
    const cacheDirectory = path.join(getModelsDirectory(), 'llama');
    const currentEntries = Array.from(getDirectoryEntries(cacheDirectory));
    currentEntries.sort((first, second) => second.length - first.length);

    for (const entryPath of currentEntries) {
        if (!llamaCacheSnapshot.has(entryPath)) {
            fs.rmSync(entryPath, { recursive: true, force: true });
        }
    }
}

async function prepareNativeFiles(llamaModelReference, whisperModel, signal) {
    const binaryProgress = label => progress => {
        sendToRenderer('update-status', formatDownloadStatus(label, progress));
        sendDownloadProgress(label, progress);
    };
    const usesApi = isApiModel(llamaModelReference);

    let llamaBinaryPath = null;
    if (!usesApi) {
        sendDownloadProgress('Checking Llama runner');
        llamaBinaryPath = await ensureNativeBinary('llama', binaryProgress('Llama runner'), signal);
    }

    sendDownloadProgress('Checking Whisper runner');
    const whisperBinaryPath = await ensureNativeBinary('whisper', binaryProgress('Whisper runner'), signal);

    let whisperModelPath;
    sendToRenderer('whisper-downloading', true);
    try {
        sendDownloadProgress('Checking Whisper model');
        whisperModelPath = await ensureWhisperModel(whisperModel, binaryProgress('Whisper model'), signal);
    } finally {
        sendToRenderer('whisper-downloading', false);
    }

    if (usesApi) {
        return { whisperBinaryPath, whisperModelPath };
    }

    sendDownloadProgress('Checking language model');
    const llamaFiles = await ensureLlamaModel(llamaModelReference, binaryProgress('Language model'), binaryProgress('Vision model'), signal);
    return {
        llamaBinaryPath,
        whisperBinaryPath,
        whisperModelPath,
        llamaModelPath: llamaFiles.modelPath,
        projectorPath: llamaFiles.projectorPath,
    };
}

function validatePreparedNativeFiles(nativeFiles, usesApi) {
    const whisperFiles = [
        ['Whisper runner', nativeFiles.whisperBinaryPath],
        ['Whisper model', nativeFiles.whisperModelPath],
    ];
    const llamaFiles = [
        ['Llama runner', nativeFiles.llamaBinaryPath],
        ['Language model', nativeFiles.llamaModelPath],
        ['Vision model', nativeFiles.projectorPath],
    ];
    const requiredFiles = usesApi ? whisperFiles : [...whisperFiles, ...llamaFiles];

    for (const [label, filePath] of requiredFiles) {
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(`${label} path is invalid: ${filePath}`);
        }
    }
}

async function startWhisperServer(executablePath, modelPath) {
    const port = await getAvailablePort();
    whisperBaseUrl = `http://127.0.0.1:${port}`;
    whisperProcess = startNativeServer({
        executablePath,
        arguments: ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port)],
        name: 'Whisper',
    });

    await waitForServer(`${whisperBaseUrl}/`, whisperProcess, 120000);
}

async function startLlamaServer(executablePath, modelPath, projectorPath) {
    if (!modelPath || !fs.existsSync(modelPath)) {
        throw new Error(`Language model path is invalid: ${modelPath}`);
    }
    if (!projectorPath || !fs.existsSync(projectorPath)) {
        throw new Error(`Vision model path is invalid: ${projectorPath}`);
    }

    const port = await getAvailablePort();
    const argumentsList = [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--alias',
        'local',
        '-c',
        '8192',
        '-m',
        modelPath,
        '--mmproj',
        projectorPath,
    ];

    if (process.platform === 'darwin') {
        argumentsList.push('-ngl', '99');
    }

    llamaBaseUrl = `http://127.0.0.1:${port}`;
    llamaProcess = startNativeServer({
        executablePath,
        arguments: argumentsList,
        name: 'Llama',
    });

    await waitForServer(`${llamaBaseUrl}/health`, llamaProcess, 30 * 60 * 1000);
}

// prepareArgs — the role picked on the start screen (none = every wiki note).
function prepareArgs() {
    const roleId = getPreferences().standmeetRoleId;
    return roleId ? { role_id: roleId } : {};
}

// preloadCorpus — asks StandMeet to load the saved role's notes while the app waits on the start
// screen, so the first card of a session does not wait for it. A failure is only logged: the
// session start asks again and reports it.
function preloadCorpus() {
    return call('assistant.prepare', prepareArgs()).catch(error => console.warn('[LocalAI] prepare failed:', error.message));
}

async function initializeLocalSession(model, whisperModel, profile, customPrompt) {
    console.log('[LocalAI] Initializing native local session:', { model, whisperModel, profile });
    sendToRenderer('session-initializing', true);

    try {
        closeLocalSession();
        initializationController = new AbortController();
        llamaCacheSnapshot = getDirectoryEntries(path.join(getModelsDirectory(), 'llama'));
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
        currentProfile = profile;
        currentCustomPrompt = customPrompt || '';
        llamaModel = model;

        // Cue Cards: the card is made on StandMeet, from the role chosen for this interview; this
        // app needs no model of its own for it, only Whisper.
        const cues = profile === 'cues';
        const usesApi = cues || isApiModel(model);
        if (!cues && usesApi && !getCredentials().deepseekApiKey) {
            throw new Error('Add your DeepSeek API key to use DeepSeek');
        }
        const prepared = cues ? call('assistant.prepare', prepareArgs()).then(p => ({ p }), error => ({ error })) : Promise.resolve({});

        const nativeFiles = await prepareNativeFiles(cues ? API_PREFIX : model, whisperModel, initializationController.signal);
        validatePreparedNativeFiles(nativeFiles, usesApi);

        sendToRenderer('update-status', 'Starting Whisper...');
        sendDownloadProgress('Starting Whisper');
        await startWhisperServer(nativeFiles.whisperBinaryPath, nativeFiles.whisperModelPath);

        sendToRenderer('update-status', 'Reading your corpus...');
        const corpus = await prepared;
        if (corpus.error) {
            throw new Error(`Could not reach your StandMeet notes: ${corpus.error.message.replace(/^StandMeet [\w.]+: /, '')}`);
        }
        if (cues) cueSession = { roleId: getPreferences().standmeetRoleId || null, callId: crypto.randomUUID(), hint: corpus.p.hint };

        if (!usesApi) {
            sendToRenderer('update-status', 'Loading local language model...');
            sendDownloadProgress('Loading language model');
            await startLlamaServer(nativeFiles.llamaBinaryPath, nativeFiles.llamaModelPath, nativeFiles.projectorPath);
        }

        streams = { them: newStream(), me: newStream() };
        localConversationHistory = [];

        initializeNewSession(profile, customPrompt);
        isLocalActive = true;
        await startPulling(takeFeedEvent);
        initializationController = null;
        sendToRenderer('local-ai-download-progress', { active: false });
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', cues ? `Ready (${corpus.p.notes} notes) - Listening...` : 'Local AI ready - Listening...');
        console.log('[LocalAI] Native session initialized successfully');
        return true;
    } catch (error) {
        const wasCancelled = error.name === 'AbortError' || initializationController?.signal.aborted;
        if (wasCancelled) {
            console.log('[LocalAI] Initialization cancelled');
        } else {
            console.error('[LocalAI] Initialization error:', error);
        }
        closeLocalSession();
        if (wasCancelled) {
            removeNewLlamaCacheEntries();
        }
        sendToRenderer('local-ai-download-progress', { active: false });
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', wasCancelled ? 'Local AI download cancelled' : 'Local AI error: ' + error.message);
        return false;
    }
}

// processLocalAudio — one 24 kHz mono chunk from a stream: 'them' (computer audio, the default) or
// 'me' (the microphone).
function processLocalAudio(monoChunk24k, source = 'them') {
    if (!isLocalActive) return;

    const stream = streams[source];
    const pcm16k = resample24kTo16k(stream, monoChunk24k);
    if (pcm16k.length > 0) {
        processVad(source, stream, pcm16k);
    }
}

function closeLocalSession() {
    isLocalActive = false;
    cueSession = null;
    shownCue = null;
    stopPulling();
    initializationController?.abort();
    initializationController = null;
    stopNativeServer(llamaProcess);
    stopNativeServer(whisperProcess);
    llamaProcess = null;
    whisperProcess = null;
    llamaBaseUrl = null;
    whisperBaseUrl = null;
    llamaModel = null;
    streams = { them: newStream(), me: newStream() };
    localConversationHistory = [];
    currentSystemPrompt = null;
}

async function cancelLocalInitialization() {
    if (!initializationController) {
        return false;
    }

    initializationController.abort();
    stopNativeServer(llamaProcess);
    stopNativeServer(whisperProcess);
    await new Promise(resolve => setTimeout(resolve, 300));
    removeNewLlamaCacheEntries();
    sendToRenderer('local-ai-download-progress', { active: false });
    sendToRenderer('session-initializing', false);
    return true;
}

function isLocalSessionActive() {
    return isLocalActive;
}

async function sendLocalText(text) {
    if (!isLocalActive) {
        return { success: false, error: 'No active local session' };
    }

    try {
        const line = { text, source: 'typed', at: Date.now() };
        sendToRenderer('transcript-line', line);
        saveTranscriptLine(line);
        await sendToLlama(text);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function sendLocalImage(base64Data, prompt) {
    if (!isLocalActive) {
        return { success: false, error: 'No active local session' };
    }

    const userMessage = {
        role: 'user',
        content: [
            { type: 'text', text: prompt },
            {
                type: 'image_url',
                image_url: {
                    url: `data:image/jpeg;base64,${base64Data}`,
                },
            },
        ],
    };

    localConversationHistory.push({ role: 'user', content: prompt });
    if (localConversationHistory.length > 20) {
        localConversationHistory = localConversationHistory.slice(-20);
    }

    try {
        sendToRenderer('update-status', 'Analyzing image...');
        const messages = [
            { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
            ...localConversationHistory.slice(0, -1),
            userMessage,
        ];

        let isFirst = true;
        const fullText = await requestLlama(messages, text => {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            isFirst = false;
        });

        if (fullText.trim()) {
            localConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveConversationTurn(prompt, fullText);
        }

        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: fullText, model: llamaModel };
    } catch (error) {
        console.error('[LocalAI] Image error:', error);
        sendToRenderer('update-status', 'Local AI image error: ' + error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    preloadCorpus,
    initializeLocalSession,
    cancelLocalInitialization,
    processLocalAudio,
    closeLocalSession,
    isLocalSessionActive,
    sendLocalText,
    sendLocalImage,
};
