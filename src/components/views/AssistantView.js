import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import './IPhoneCalls.js';

// transcriptLines — what the assistant heard (and what the user typed) this session, oldest first.
// Module-level so it survives the view being re-created when the user navigates away and back.
const transcriptLines = [];

// leadSplit — bold leading letters ("bionic reading"): the eye lands on the bold start of each
// word and the rest follows. Returns [before, lead, rest]; leading punctuation stays unbolded and
// words with no Latin letters (CJK, numbers) are left whole.
function leadSplit(word) {
    const m = /^([^A-Za-z]*)([A-Za-z][\w'’-]*)(.*)$/s.exec(word);
    if (!m) return [word, '', ''];
    const core = m[2];
    const n = core.length <= 3 ? 1 : core.length === 4 ? 2 : core.length <= 7 ? 3 : core.length <= 10 ? 4 : Math.ceil(core.length * 0.4);
    return [m[1], core.slice(0, n), core.slice(n) + m[3]];
}

// ── Charts: a ```mermaid fence in a card becomes a diagram ──
//
// Only a closed fence is drawn — a card still streaming shows its code. A diagram that does not
// parse stays code: the card never shows mermaid's error text. Each source renders once; the card
// re-renders on every streamed token and reuses the SVG.

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)\n```/g;
const diagrams = new Map(); // source → Promise<svg string | null>
let diagramSeq = 0;
let mermaidReady = false;

function diagramFor(source) {
    if (!diagrams.has(source)) diagrams.set(source, drawDiagram(source));
    return diagrams.get(source);
}

async function drawDiagram(source) {
    const mermaid = window.mermaid;
    if (!mermaid) return null;
    if (!mermaidReady) {
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            suppressErrorRendering: true,
            theme: 'base',
            // paper / ink: the StandMeet palette
            themeVariables: {
                fontFamily: 'JetBrains Mono, monospace',
                background: '#F3EFE6',
                primaryColor: '#F3EFE6',
                primaryTextColor: '#1B1814',
                primaryBorderColor: '#1B1814',
                lineColor: '#1B1814',
                pie1: '#B5391C',
                pie2: '#1B1814',
                pie3: '#7A7167',
                pie4: '#DCD3BF',
                pie5: '#D14E2E',
                pieStrokeColor: '#F3EFE6',
                pieOuterStrokeColor: '#1B1814',
                pieOpacity: '1',
            },
        });
        mermaidReady = true;
    }
    try {
        if (!(await mermaid.parse(source, { suppressErrors: true }))) return null;
        const { svg } = await mermaid.render(`cue-diagram-${++diagramSeq}`, source);
        return svg;
    } catch {
        return null;
    }
}

function closedDiagrams(markdown) {
    return new Set([...markdown.matchAll(MERMAID_FENCE)].map(m => m[1].trim()));
}

// SPEAKER — whose line it is: the computer's audio is the other side, the microphone is the owner.
const SPEAKER = { them: 'Them', me: 'Me', typed: 'Me · typed' };

function clock(at) {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export class AssistantView extends LitElement {
    static styles = css`
        :host {
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        /* ── What is being heard: computer audio or a phone call ── */

        .listening-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px var(--space-md);
            font-family: var(--font-mono);
            font-size: 11px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: var(--text-secondary);
            border-bottom: 1px solid var(--border-subtle, var(--border));
            background: var(--bg-app);
        }

        .indicator-help {
            margin-left: auto;
            border: none;
            background: none;
            padding: 0;
            font: inherit;
            letter-spacing: inherit;
            text-transform: inherit;
            color: var(--text-secondary);
            cursor: pointer;
        }

        .indicator-help:hover {
            color: var(--text-primary);
        }

        .iphone-calls-slot {
            padding: var(--space-sm) var(--space-md);
            border-bottom: 1px solid var(--border-subtle, var(--border));
            background: var(--bg-app);
        }

        .listening-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #b5391c;
            animation: listening-pulse 1.6s ease-in-out infinite;
        }

        @keyframes listening-pulse {
            0%,
            100% {
                opacity: 1;
            }
            50% {
                opacity: 0.3;
            }
        }

        /* ── Charts ── */

        .response-container .cue-diagram {
            margin: var(--space-sm) 0;
        }

        .response-container .cue-diagram svg {
            max-width: 100%;
            height: auto;
            max-height: 260px;
        }

        /* ── Cue + transcript side by side ── */

        .main {
            flex: 1;
            display: flex;
            min-height: 0;
        }

        .main .response-container {
            flex: 1;
            min-width: 0;
        }

        .transcript {
            width: 32%;
            min-width: 180px;
            max-width: 340px;
            border-left: 1px solid var(--border-subtle, var(--border));
            background: var(--bg-app);
            overflow-y: auto;
            padding: var(--space-sm) var(--space-md);
            display: flex;
            flex-direction: column;
            gap: var(--space-sm);
            user-select: text;
        }

        .transcript-title {
            font-size: 11px;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: var(--text-muted);
        }

        .transcript-empty {
            font-size: 13px;
            color: var(--text-muted);
        }

        .transcript-line {
            font-size: 13px;
            line-height: 1.45;
            color: var(--text-secondary);
            cursor: text;
        }

        .transcript-line:last-child {
            color: var(--text-primary);
        }

        /* Their lines carry the accent rule; mine sit indented and quieter — kept for review only. */
        .transcript-line.them {
            border-left: 2px solid #b5391c;
            padding-left: 8px;
        }

        .transcript-line.me,
        .transcript-line.typed {
            margin-left: 12px;
            padding-left: 8px;
            border-left: 2px solid var(--border-strong, var(--border));
            font-style: italic;
        }

        .transcript-who {
            font-weight: 600;
            letter-spacing: 0.04em;
            color: var(--text-secondary);
        }

        /* Bold leading letters: the lead carries the weight, the rest of the word stays light. */
        .lead,
        .response-container b.lead {
            font-weight: 700;
            color: var(--text-primary);
        }

        .transcript-meta {
            display: block;
            font-family: var(--font-mono);
            font-size: 10.5px;
            color: var(--text-muted);
        }

        * {
            font-family: var(--font);
            cursor: default;
        }

        /* ── Response area ── */

        .response-container {
            flex: 1;
            overflow-y: auto;
            font-size: var(--response-font-size, 15px);
            line-height: var(--line-height);
            background: var(--bg-app);
            padding: var(--space-sm) var(--space-md);
            scroll-behavior: smooth;
            user-select: text;
            cursor: text;
            color: var(--text-primary);
        }

        .response-container * {
            user-select: text;
            cursor: text;
        }

        .response-container a {
            cursor: pointer;
        }

        .response-container [data-word] {
            display: inline-block;
        }

        /* ── Markdown ── */

        .response-container h1,
        .response-container h2,
        .response-container h3,
        .response-container h4,
        .response-container h5,
        .response-container h6 {
            margin: 1em 0 0.5em 0;
            color: var(--text-primary);
            font-weight: var(--font-weight-semibold);
        }

        .response-container h1 { font-size: 1.5em; }
        .response-container h2 { font-size: 1.3em; }
        .response-container h3 { font-size: 1.15em; }
        .response-container h4 { font-size: 1.05em; }
        .response-container h5,
        .response-container h6 { font-size: 1em; }

        .response-container p {
            margin: 0.6em 0;
            color: var(--text-primary);
        }

        .response-container ul,
        .response-container ol {
            margin: 0.6em 0;
            padding-left: 1.5em;
            color: var(--text-primary);
        }

        .response-container li {
            margin: 0.3em 0;
        }

        .response-container blockquote {
            margin: 0.8em 0;
            padding: 0.5em 1em;
            border-left: 2px solid var(--border-strong);
            background: var(--bg-surface);
            border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
        }

        .response-container code {
            background: var(--bg-elevated);
            padding: 0.15em 0.4em;
            border-radius: var(--radius-sm);
            font-family: var(--font-mono);
            font-size: 0.85em;
        }

        .response-container pre {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: var(--radius-md);
            padding: var(--space-md);
            overflow-x: auto;
            margin: 0.8em 0;
        }

        .response-container pre code {
            background: none;
            padding: 0;
        }

        .response-container a {
            color: var(--accent);
            text-decoration: underline;
            text-underline-offset: 2px;
        }

        .response-container strong,
        .response-container b {
            font-weight: var(--font-weight-semibold);
        }

        .response-container hr {
            border: none;
            border-top: 1px solid var(--border);
            margin: 1.5em 0;
        }

        .response-container table {
            border-collapse: collapse;
            width: 100%;
            margin: 0.8em 0;
        }

        .response-container th,
        .response-container td {
            border: 1px solid var(--border);
            padding: var(--space-sm);
            text-align: left;
        }

        .response-container th {
            background: var(--bg-surface);
            font-weight: var(--font-weight-semibold);
        }

        .response-container::-webkit-scrollbar {
            width: 6px;
        }

        .response-container::-webkit-scrollbar-track {
            background: transparent;
        }

        .response-container::-webkit-scrollbar-thumb {
            background: var(--border-strong);
            border-radius: 3px;
        }

        .response-container::-webkit-scrollbar-thumb:hover {
            background: #444444;
        }

        /* ── Response navigation strip ── */

        .response-nav {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: var(--space-sm);
            padding: var(--space-xs) var(--space-md);
            border-top: 1px solid var(--border);
            background: var(--bg-app);
        }

        .nav-btn {
            background: none;
            border: none;
            color: var(--text-muted);
            cursor: pointer;
            padding: var(--space-xs);
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
            transition: color var(--transition);
        }

        .nav-btn:hover:not(:disabled) {
            color: var(--text-primary);
        }

        .nav-btn:disabled {
            opacity: 0.25;
            cursor: default;
        }

        .nav-btn svg {
            width: 14px;
            height: 14px;
        }

        .response-counter {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
            font-family: var(--font-mono);
            min-width: 40px;
            text-align: center;
        }

        /* ── Bottom input bar ── */

        .input-bar {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
            padding: var(--space-md);
            background: var(--bg-app);
        }

        .input-bar-inner {
            display: flex;
            align-items: center;
            flex: 1;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            border-radius: 100px;
            padding: 0 var(--space-md);
            height: 32px;
            transition: border-color var(--transition);
        }

        .input-bar-inner:focus-within {
            border-color: var(--accent);
        }

        .input-bar-inner input {
            flex: 1;
            background: none;
            color: var(--text-primary);
            border: none;
            padding: 0;
            font-size: var(--font-size-sm);
            font-family: var(--font);
            height: 100%;
            outline: none;
        }

        .input-bar-inner input::placeholder {
            color: var(--text-muted);
        }

        .analyze-btn {
            position: relative;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            color: var(--text-primary);
            cursor: pointer;
            font-size: var(--font-size-xs);
            font-family: var(--font-mono);
            white-space: nowrap;
            padding: var(--space-xs) var(--space-md);
            border-radius: 100px;
            height: 32px;
            display: flex;
            align-items: center;
            gap: 4px;
            transition: border-color 0.4s ease, background var(--transition);
            flex-shrink: 0;
            overflow: hidden;
        }

        .analyze-btn:hover:not(.analyzing) {
            border-color: var(--accent);
            background: var(--bg-surface);
        }

        .analyze-btn.analyzing {
            cursor: default;
            border-color: transparent;
        }

        .analyze-btn-content {
            display: flex;
            align-items: center;
            gap: 4px;
            transition: opacity 0.4s ease;
            z-index: 1;
            position: relative;
        }

        .analyze-btn.analyzing .analyze-btn-content {
            opacity: 0;
        }

        .analyze-canvas {
            position: absolute;
            inset: -1px;
            width: calc(100% + 2px);
            height: calc(100% + 2px);
            pointer-events: none;
        }
    `;

    static properties = {
        responses: { type: Array },
        currentResponseIndex: { type: Number },
        selectedProfile: { type: String },
        onSendText: { type: Function },
        shouldAnimateResponse: { type: Boolean },
        isAnalyzing: { type: Boolean, state: true },
        listeningSource: { type: String, state: true }, // 'computer' | 'phone', from the CallState helper
        showIPhoneCalls: { type: Boolean, state: true }, // the "how an iPhone call reaches here" panel
    };

    constructor() {
        super();
        this.responses = [];
        this.currentResponseIndex = -1;
        this.selectedProfile = 'interview';
        this.onSendText = () => {};
        this.isAnalyzing = false;
        this.listeningSource = 'computer';
        this._animFrame = null;
    }

    getProfileNames() {
        return {
            cues: 'Cue Cards',
            interview: 'Job Interview',
            sales: 'Sales Call',
            meeting: 'Business Meeting',
            presentation: 'Presentation',
            negotiation: 'Negotiation',
            exam: 'Exam Assistant',
        };
    }

    getCurrentResponse() {
        const profileNames = this.getProfileNames();
        return this.responses.length > 0 && this.currentResponseIndex >= 0
            ? this.responses[this.currentResponseIndex]
            : `Listening to your ${profileNames[this.selectedProfile] || 'session'}...`;
    }

    renderMarkdown(content) {
        if (typeof window !== 'undefined' && window.marked) {
            try {
                window.marked.setOptions({
                    breaks: true,
                    gfm: true,
                    sanitize: false,
                });
                let rendered = window.marked.parse(content);
                rendered = this.wrapWordsInSpans(rendered);
                return rendered;
            } catch (error) {
                console.warn('Error parsing markdown:', error);
                return content;
            }
        }
        return content;
    }

    wrapWordsInSpans(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const tagsToSkip = ['PRE'];

        function wrap(node) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() && !tagsToSkip.includes(node.parentNode.tagName)) {
                const words = node.textContent.split(/(\s+)/);
                const frag = document.createDocumentFragment();
                words.forEach(word => {
                    if (word.trim()) {
                        const span = document.createElement('span');
                        span.setAttribute('data-word', '');
                        const [before, lead, rest] = leadSplit(word);
                        if (lead) {
                            const b = document.createElement('b');
                            b.className = 'lead';
                            b.textContent = lead;
                            span.append(before, b, rest);
                        } else {
                            span.textContent = word;
                        }
                        frag.appendChild(span);
                    } else {
                        frag.appendChild(document.createTextNode(word));
                    }
                });
                node.parentNode.replaceChild(frag, node);
            } else if (node.nodeType === Node.ELEMENT_NODE && !tagsToSkip.includes(node.tagName)) {
                Array.from(node.childNodes).forEach(wrap);
            }
        }
        Array.from(doc.body.childNodes).forEach(wrap);
        return doc.body.innerHTML;
    }

    navigateToPreviousResponse() {
        if (this.currentResponseIndex > 0) {
            this.currentResponseIndex--;
            this.dispatchEvent(
                new CustomEvent('response-index-changed', {
                    detail: { index: this.currentResponseIndex },
                })
            );
            this.requestUpdate();
        }
    }

    navigateToNextResponse() {
        if (this.currentResponseIndex < this.responses.length - 1) {
            this.currentResponseIndex++;
            this.dispatchEvent(
                new CustomEvent('response-index-changed', {
                    detail: { index: this.currentResponseIndex },
                })
            );
            this.requestUpdate();
        }
    }

    scrollResponseUp() {
        const container = this.shadowRoot.querySelector('.response-container');
        if (container) {
            const scrollAmount = container.clientHeight * 0.3;
            container.scrollTop = Math.max(0, container.scrollTop - scrollAmount);
        }
    }

    scrollResponseDown() {
        const container = this.shadowRoot.querySelector('.response-container');
        if (container) {
            const scrollAmount = container.clientHeight * 0.3;
            container.scrollTop = Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + scrollAmount);
        }
    }

    connectedCallback() {
        super.connectedCallback();

        if (window.require) {
            const { ipcRenderer } = window.require('electron');

            this.handlePreviousResponse = () => this.navigateToPreviousResponse();
            this.handleNextResponse = () => this.navigateToNextResponse();
            this.handleScrollUp = () => this.scrollResponseUp();
            this.handleScrollDown = () => this.scrollResponseDown();
            this.handleTranscriptLine = (_event, line) => {
                transcriptLines.push(line);
                this.requestUpdate();
                this.updateComplete.then(() => this.scrollTranscriptToBottom());
            };
            this.handleSessionInitializing = (_event, initializing) => {
                if (initializing) transcriptLines.length = 0;
                this.requestUpdate();
            };

            this.handleListeningSource = (_event, source) => {
                this.listeningSource = source;
            };
            ipcRenderer.on('listening-source', this.handleListeningSource);
            ipcRenderer.on('transcript-line', this.handleTranscriptLine);
            ipcRenderer.on('session-initializing', this.handleSessionInitializing);
            ipcRenderer.on('navigate-previous-response', this.handlePreviousResponse);
            ipcRenderer.on('navigate-next-response', this.handleNextResponse);
            ipcRenderer.on('scroll-response-up', this.handleScrollUp);
            ipcRenderer.on('scroll-response-down', this.handleScrollDown);
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._stopWaveformAnimation();

        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            if (this.handlePreviousResponse) ipcRenderer.removeListener('navigate-previous-response', this.handlePreviousResponse);
            if (this.handleNextResponse) ipcRenderer.removeListener('navigate-next-response', this.handleNextResponse);
            if (this.handleScrollUp) ipcRenderer.removeListener('scroll-response-up', this.handleScrollUp);
            if (this.handleScrollDown) ipcRenderer.removeListener('scroll-response-down', this.handleScrollDown);
            if (this.handleTranscriptLine) ipcRenderer.removeListener('transcript-line', this.handleTranscriptLine);
            if (this.handleListeningSource) ipcRenderer.removeListener('listening-source', this.handleListeningSource);
            if (this.handleSessionInitializing) ipcRenderer.removeListener('session-initializing', this.handleSessionInitializing);
        }
    }

    scrollTranscriptToBottom() {
        const panel = this.shadowRoot.querySelector('.transcript');
        if (panel) panel.scrollTop = panel.scrollHeight;
    }

    renderTranscript() {
        return html`
            <aside class="transcript" aria-label="Transcript">
                <div class="transcript-title">Transcript</div>
                ${transcriptLines.length === 0
                    ? html`<div class="transcript-empty">What the other side says appears here.</div>`
                    : transcriptLines.map(
                          line => html`
                              <div class="transcript-line ${line.source}">
                                  <span class="transcript-meta"><b class="transcript-who">${SPEAKER[line.source] || 'Them'}</b> · ${clock(line.at)}</span>
                                  ${line.text.split(/(\s+)/).map(word => {
                                      const [before, lead, rest] = leadSplit(word);
                                      return lead ? html`${before}<b class="lead">${lead}</b>${rest}` : word;
                                  })}
                              </div>
                          `,
                      )}
            </aside>
        `;
    }

    async handleSendText() {
        const textInput = this.shadowRoot.querySelector('#textInput');
        if (textInput && textInput.value.trim()) {
            const message = textInput.value.trim();
            textInput.value = '';
            await this.onSendText(message);
        }
    }

    handleTextKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.handleSendText();
        }
    }

    async handleScreenAnswer() {
        if (this.isAnalyzing) return;
        if (window.captureManualScreenshot) {
            this.isAnalyzing = true;
            this._responseCountWhenStarted = this.responses.length;
            window.captureManualScreenshot();
        }
    }

    _startWaveformAnimation() {
        const canvas = this.shadowRoot.querySelector('.analyze-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;

        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const dangerColor = getComputedStyle(this).getPropertyValue('--danger').trim() || '#EF4444';
        const startTime = performance.now();
        const FADE_IN = 0.5; // seconds
        const PARTICLE_SPREAD = 4; // px inward from border
        const PARTICLE_COUNT = 250;

        // Pill perimeter helpers
        const w = rect.width;
        const h = rect.height;
        const r = h / 2; // pill radius = half height
        const straightLen = w - 2 * r;
        const arcLen = Math.PI * r;
        const perimeter = 2 * straightLen + 2 * arcLen;

        // Given a distance along the perimeter, return {x, y, nx, ny} (position + inward normal)
        const pointOnPerimeter = (d) => {
            d = ((d % perimeter) + perimeter) % perimeter;
            // Top straight: left to right
            if (d < straightLen) {
                return { x: r + d, y: 0, nx: 0, ny: 1 };
            }
            d -= straightLen;
            // Right arc
            if (d < arcLen) {
                const angle = -Math.PI / 2 + (d / arcLen) * Math.PI;
                return {
                    x: w - r + Math.cos(angle) * r,
                    y: r + Math.sin(angle) * r,
                    nx: -Math.cos(angle),
                    ny: -Math.sin(angle),
                };
            }
            d -= arcLen;
            // Bottom straight: right to left
            if (d < straightLen) {
                return { x: w - r - d, y: h, nx: 0, ny: -1 };
            }
            d -= straightLen;
            // Left arc
            const angle = Math.PI / 2 + (d / arcLen) * Math.PI;
            return {
                x: r + Math.cos(angle) * r,
                y: r + Math.sin(angle) * r,
                nx: -Math.cos(angle),
                ny: -Math.sin(angle),
            };
        };

        // Pre-seed random offsets for stable particles
        const seeds = [];
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            seeds.push({ pos: Math.random(), drift: Math.random(), depthSeed: Math.random() });
        }

        const draw = (now) => {
            const elapsed = (now - startTime) / 1000;
            const fade = Math.min(1, elapsed / FADE_IN);

            ctx.clearRect(0, 0, w, h);

            // ── Particle border ──
            ctx.fillStyle = dangerColor;
            for (let i = 0; i < PARTICLE_COUNT; i++) {
                const s = seeds[i];
                const along = (s.pos + s.drift * elapsed * 0.03) * perimeter;
                const depth = s.depthSeed * PARTICLE_SPREAD;
                const density = 1 - depth / PARTICLE_SPREAD;

                if (Math.random() > density) continue;

                const p = pointOnPerimeter(along);
                const px = p.x + p.nx * depth;
                const py = p.y + p.ny * depth;
                const size = 0.8 + density * 0.6;

                ctx.globalAlpha = fade * density * 0.85;
                ctx.beginPath();
                ctx.arc(px, py, size, 0, Math.PI * 2);
                ctx.fill();
            }

            // ── Waveform ──
            const midY = h / 2;
            const waves = [
                { freq: 3, amp: 0.35, speed: 2.5, opacity: 0.9, width: 1.8 },
                { freq: 5, amp: 0.2, speed: 3.5, opacity: 0.5, width: 1.2 },
                { freq: 7, amp: 0.12, speed: 5, opacity: 0.3, width: 0.8 },
            ];

            for (const wave of waves) {
                ctx.beginPath();
                ctx.strokeStyle = dangerColor;
                ctx.globalAlpha = wave.opacity * fade;
                ctx.lineWidth = wave.width;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                for (let x = 0; x <= w; x++) {
                    const norm = x / w;
                    const envelope = Math.sin(norm * Math.PI);
                    const y = midY + Math.sin(norm * Math.PI * 2 * wave.freq + elapsed * wave.speed) * (midY * wave.amp) * envelope;
                    if (x === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }

            ctx.globalAlpha = 1;
            this._animFrame = requestAnimationFrame(draw);
        };

        this._animFrame = requestAnimationFrame(draw);
    }

    _stopWaveformAnimation() {
        if (this._animFrame) {
            cancelAnimationFrame(this._animFrame);
            this._animFrame = null;
        }
        const canvas = this.shadowRoot.querySelector('.analyze-canvas');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    scrollToBottom() {
        setTimeout(() => {
            const container = this.shadowRoot.querySelector('.response-container');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }, 0);
    }

    firstUpdated() {
        super.firstUpdated();
        this.updateResponseContent();
    }

    updated(changedProperties) {
        super.updated(changedProperties);
        if (changedProperties.has('responses') || changedProperties.has('currentResponseIndex')) {
            this.updateResponseContent();
        }

        if (changedProperties.has('isAnalyzing')) {
            if (this.isAnalyzing) {
                this._startWaveformAnimation();
            } else {
                this._stopWaveformAnimation();
            }
        }

        if (changedProperties.has('responses') && this.isAnalyzing) {
            if (this.responses.length > this._responseCountWhenStarted) {
                this.isAnalyzing = false;
            }
        }
    }

    updateResponseContent() {
        const container = this.shadowRoot.querySelector('#responseContainer');
        if (container) {
            const currentResponse = this.getCurrentResponse();
            const renderedResponse = this.renderMarkdown(currentResponse);
            container.innerHTML = renderedResponse;
            this.drawDiagrams(container, currentResponse);
            if (this.shouldAnimateResponse) {
                this.dispatchEvent(new CustomEvent('response-animation-complete', { bubbles: true, composed: true }));
            }
        }
    }

    // drawDiagrams — swaps each closed mermaid code block in the card for its diagram.
    drawDiagrams(container, markdown) {
        const closed = closedDiagrams(markdown);
        for (const code of container.querySelectorAll('code.language-mermaid')) {
            const source = code.textContent.trim();
            if (!closed.has(source)) continue;
            diagramFor(source).then(svg => {
                if (!svg || !code.isConnected) return;
                const figure = document.createElement('figure');
                figure.className = 'cue-diagram';
                figure.innerHTML = svg;
                code.closest('pre').replaceWith(figure);
            });
        }
    }

    render() {
        const hasMultipleResponses = this.responses.length > 1;

        return html`
            <div class="listening-indicator" role="status">
                <span class="listening-dot"></span>
                Listening: ${this.listeningSource === 'phone' ? 'phone call' : 'computer audio'}
                <button class="indicator-help" @click=${() => (this.showIPhoneCalls = !this.showIPhoneCalls)}>
                    iPhone calls ${this.showIPhoneCalls ? '▾' : '▸'}
                </button>
            </div>
            ${this.showIPhoneCalls ? html`<div class="iphone-calls-slot"><iphone-calls listening></iphone-calls></div>` : ''}
            <div class="main">
                <div class="response-container" id="responseContainer"></div>
                ${this.renderTranscript()}
            </div>

            ${hasMultipleResponses ? html`
                <div class="response-nav">
                    <button class="nav-btn" @click=${this.navigateToPreviousResponse} ?disabled=${this.currentResponseIndex <= 0} title="Previous response">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd" />
                        </svg>
                    </button>
                    <span class="response-counter">${this.currentResponseIndex + 1} of ${this.responses.length}</span>
                    <button class="nav-btn" @click=${this.navigateToNextResponse} ?disabled=${this.currentResponseIndex >= this.responses.length - 1} title="Next response">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
                        </svg>
                    </button>
                </div>
            ` : ''}

            <div class="input-bar">
                <div class="input-bar-inner">
                    <input
                        type="text"
                        id="textInput"
                        placeholder="Type a message..."
                        @keydown=${this.handleTextKeydown}
                    />
                </div>
                <button class="analyze-btn ${this.isAnalyzing ? 'analyzing' : ''}" @click=${this.handleScreenAnswer}>
                    <canvas class="analyze-canvas"></canvas>
                    <span class="analyze-btn-content">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
                            <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 3v7h6l-8 11v-7H5z" />
                        </svg>
                        Analyze Screen
                    </span>
                </button>
            </div>
        `;
    }
}

customElements.define('assistant-view', AssistantView);
