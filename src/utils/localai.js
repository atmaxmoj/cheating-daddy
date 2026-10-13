const fs = require('fs');
const path = require('path');
const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn } = require('./gemini');
const { publishTranscript, publishCue, newCueID } = require('./feed');
const standmeet = require('./standmeet');
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

// systemPromptFor — the Cue Cards profile draws its context per question from the user's
// StandMeet corpus (the notes that match what was just said); anything typed in AI Context rides
// along. Every other profile keeps the fixed prompt built at session start.
function systemPromptFor(query) {
    if (currentProfile !== 'cues' || !standmeet.isLoaded()) return currentSystemPrompt;
    const job = standmeet.noticeCompany(query);
    if (job) sendToRenderer('update-status', `Phone screen: ${job.company}${job.title ? ` — ${job.title}` : ''}`);
    const extra = currentCustomPrompt.trim() ? `\n\n## Also from the user\n${currentCustomPrompt.trim()}` : '';
    return getSystemPrompt('cues', standmeet.contextFor(query) + extra, false);
}
let isLocalActive = false;
let initializationController = null;
let llamaCacheSnapshot = new Set();

let isSpeaking = false;
let speechBuffers = [];
let silenceFrameCount = 0;
let speechFrameCount = 0;
let voicedFrameCount = 0; // loud frames in the current turn (the buffer also holds its silences)
const MIN_VOICED_FRAMES = 5; // ~0.5 s of actual speech before a turn is worth transcribing

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
let resampleRemainder = Buffer.alloc(0);

function resample24kTo16k(inputBuffer) {
    const combined = Buffer.concat([resampleRemainder, inputBuffer]);
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
    resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

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
let levelPeak = 0;
let levelLoggedAt = 0;

function logLevel(rms) {
    levelPeak = Math.max(levelPeak, rms);
    const now = Date.now();
    if (now - levelLoggedAt < 5000) return;
    console.log(`[LocalAI] audio level peak ${levelPeak.toFixed(4)} (speech threshold ${vadConfig.energyThreshold})`);
    levelPeak = 0;
    levelLoggedAt = now;
}

function processVad(pcm16kBuffer) {
    const rms = calculateRms(pcm16kBuffer);
    logLevel(rms);
    const isVoice = rms > vadConfig.energyThreshold;

    if (isVoice) {
        speechFrameCount += 1;
        silenceFrameCount = 0;
        if (isSpeaking) voicedFrameCount += 1;

        if (!isSpeaking && speechFrameCount >= vadConfig.speechFramesRequired) {
            isSpeaking = true;
            speechBuffers = [];
            voicedFrameCount = 1;
            console.log('[LocalAI] Speech started (RMS:', rms.toFixed(4), ')');
            sendToRenderer('update-status', 'Listening... (speech detected)');
        }
    } else {
        silenceFrameCount += 1;
        speechFrameCount = 0;

        if (isSpeaking && silenceFrameCount >= vadConfig.silenceFramesRequired) {
            isSpeaking = false;
            const audioData = Buffer.concat(speechBuffers);
            speechBuffers = [];
            // The buffer also holds the silence that ended the turn, so its length says nothing
            // about how much was said: a cough plus 1.5 s of quiet looked like a question.
            if (voicedFrameCount < MIN_VOICED_FRAMES) {
                console.log('[LocalAI] Too little speech, skipping (', voicedFrameCount, 'voiced frames )');
                sendToRenderer('update-status', 'Listening...');
                return;
            }
            console.log('[LocalAI] Speech ended, accumulated', audioData.length, 'bytes');
            sendToRenderer('update-status', 'Transcribing...');
            handleSpeechEnd(audioData);
            return;
        }
    }

    if (isSpeaking) {
        speechBuffers.push(Buffer.from(pcm16kBuffer));
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
    // The user's project names bias Whisper toward their spelling ("StandMeet", not "stand meet").
    const hint = standmeet.transcriptionHint();
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

async function handleSpeechEnd(audioData) {
    if (!isLocalActive) return;

    if (audioData.length < 16000) {
        console.log('[LocalAI] Audio too short, skipping');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    try {
        const transcription = await transcribeAudio(audioData);

        if (!transcription || transcription.length < 2 || NON_SPEECH.test(transcription)) {
            console.log('[LocalAI] Empty transcription, skipping');
            sendToRenderer('update-status', 'Listening...');
            return;
        }

        sendToRenderer('update-status', 'Generating response...');
        sendToRenderer('transcript-line', { text: transcription, source: 'heard', at: Date.now() });
        publishTranscript(transcription);
        await sendToLlama(transcription);
    } catch (error) {
        console.error('[LocalAI] Transcription error:', error);
        sendToRenderer('update-status', 'Transcription error: ' + error.message);
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
    localConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (localConversationHistory.length > 20) {
        localConversationHistory = localConversationHistory.slice(-20);
    }

    try {
        const system = systemPromptFor(transcription) || 'You are a helpful assistant.';
        const messages = [{ role: 'system', content: system }, ...localConversationHistory];

        let isFirst = true;
        const cueID = newCueID();
        const fullText = await requestLlama(messages, text => {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            publishCue(cueID, text, false);
            isFirst = false;
        });

        if (fullText.trim()) {
            publishCue(cueID, fullText, true);
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

const DEFAULT_HOST = 'https://sijie.xyz';
let preloading = Promise.resolve();

// preloadCorpus — reads the corpus for the saved host + role while the app waits on the start
// screen, so one key starts a session without the 20 s read. A failure is only logged: the session
// start reads again and reports it.
function preloadCorpus() {
    preloading = (async () => {
        const prefs = getPreferences();
        const host = prefs.standmeetHost || DEFAULT_HOST;
        const role = await findRole(host, prefs.standmeetRoleId);
        if (standmeet.loadedCount(host, role) === null) await standmeet.loadCorpus(host, role);
    })().catch(error => console.warn('[LocalAI] corpus preload failed:', error.message));
    return preloading;
}

// findRole — the role picked on the start screen; null when none is picked. A picked role that no
// longer exists is an error, not a silent fall back to the whole corpus.
async function findRole(host, roleId) {
    if (!roleId) return null;
    const role = (await standmeet.listRoles(host)).find(r => r.id === roleId);
    if (!role) throw new Error('the chosen role no longer exists — pick another on the start screen');
    return role;
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

        const usesApi = isApiModel(model);
        if (usesApi && !getCredentials().deepseekApiKey) {
            throw new Error('Add your DeepSeek API key to use DeepSeek');
        }

        // Cue Cards: the corpus, scoped to the StandMeet role chosen for this interview (none =
        // every wiki note). The app reads it at launch (preloadCorpus); only a different role reads
        // again (about 20 s for ~700 notes). The phone screen script and the job briefs are read
        // fresh every time — a brief written an hour before the call must be there.
        let corpusProgress = '';
        const prefs = getPreferences();
        const host = prefs.standmeetHost || DEFAULT_HOST;
        await preloading;
        const corpusLoad =
            profile === 'cues'
                ? findRole(host, prefs.standmeetRoleId)
                      .then(async role => {
                          const [count] = await Promise.all([
                              standmeet.loadedCount(host, role) ??
                                  standmeet.loadCorpus(host, role, (done, total) => {
                                      corpusProgress = `${done}/${total}`;
                                  }),
                              standmeet.loadScreen(host),
                          ]);
                          return count;
                      })
                      .then(
                          count => ({ count }),
                          error => ({ error }),
                      )
                : Promise.resolve({ count: 0 });

        const nativeFiles = await prepareNativeFiles(model, whisperModel, initializationController.signal);
        validatePreparedNativeFiles(nativeFiles, usesApi);

        sendToRenderer('update-status', 'Starting Whisper...');
        sendDownloadProgress('Starting Whisper');
        await startWhisperServer(nativeFiles.whisperBinaryPath, nativeFiles.whisperModelPath);

        const ticker = setInterval(() => sendToRenderer('update-status', `Reading your corpus... ${corpusProgress}`), 500);
        const corpus = await corpusLoad.finally(() => clearInterval(ticker));
        if (corpus.error) {
            throw new Error(`Could not read your StandMeet corpus: ${corpus.error.message}`);
        }

        if (!usesApi) {
            sendToRenderer('update-status', 'Loading local language model...');
            sendDownloadProgress('Loading language model');
            await startLlamaServer(nativeFiles.llamaBinaryPath, nativeFiles.llamaModelPath, nativeFiles.projectorPath);
        }

        isSpeaking = false;
        speechBuffers = [];
        silenceFrameCount = 0;
        speechFrameCount = 0;
        resampleRemainder = Buffer.alloc(0);
        localConversationHistory = [];

        initializeNewSession(profile, customPrompt);
        isLocalActive = true;
        initializationController = null;
        sendToRenderer('local-ai-download-progress', { active: false });
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', corpus.count ? `Ready (${corpus.count} notes) - Listening...` : 'Local AI ready - Listening...');
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

function processLocalAudio(monoChunk24k) {
    if (!isLocalActive) return;

    const pcm16k = resample24kTo16k(monoChunk24k);
    if (pcm16k.length > 0) {
        processVad(pcm16k);
    }
}

function closeLocalSession() {
    isLocalActive = false;
    initializationController?.abort();
    initializationController = null;
    stopNativeServer(llamaProcess);
    stopNativeServer(whisperProcess);
    llamaProcess = null;
    whisperProcess = null;
    llamaBaseUrl = null;
    whisperBaseUrl = null;
    llamaModel = null;
    isSpeaking = false;
    speechBuffers = [];
    silenceFrameCount = 0;
    speechFrameCount = 0;
    resampleRemainder = Buffer.alloc(0);
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
        sendToRenderer('transcript-line', { text, source: 'typed', at: Date.now() });
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
