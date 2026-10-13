import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

// <iphone-calls> — how an iPhone call reaches the assistant, and whether one is on this Mac now.
//
// An iPhone call answered on the Mac (Continuity) plays through the Mac like any other audio, so the
// assistant hears it with nothing else to set up; the steps only route the call here. The status
// line asks the CallState helper every 3 s while the panel shows. `listening` = a session is on.
//
// Not shown: whether "Calls from iPhone" is turned on — macOS keeps that in no readable setting.

const POLL_MS = 3000;

export class IPhoneCalls extends LitElement {
    static properties = {
        listening: { type: Boolean },
        _state: { state: true }, // 'phone' | 'computer' | 'unknown' | null (not read yet)
    };

    static styles = css`
        .iphone-calls {
            border: 1px solid var(--border-subtle, var(--border));
            border-radius: 6px;
            padding: 10px 12px;
            font-size: 13px;
            line-height: 1.45;
            color: var(--text-primary);
            background: var(--bg-surface, transparent);
        }

        .ic-title {
            font-family: var(--font-mono);
            font-size: 11px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--text-secondary);
            margin-bottom: 6px;
        }

        .ic-status {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 8px;
            color: var(--text-secondary);
        }

        .ic-status::before {
            content: '';
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #7a7167; /* grey: no call — only a live call gets the accent */
        }

        .ic-status.on {
            color: var(--text-primary);
            font-weight: 600;
        }

        .ic-status.on::before {
            background: #b5391c;
        }

        .ic-steps {
            margin: 0;
            padding-left: 18px;
        }

        .ic-steps li {
            margin: 2px 0;
        }

        .ic-steps b {
            font-weight: 700;
        }
    `;

    constructor() {
        super();
        this.listening = false;
        this._state = null;
    }

    connectedCallback() {
        super.connectedCallback();
        this._poll();
        this._timer = setInterval(() => this._poll(), POLL_MS);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        clearInterval(this._timer);
    }

    async _poll() {
        if (!window.require) return;
        this._state = await window.require('electron').ipcRenderer.invoke('call-state');
    }

    _statusText() {
        if (this._state === 'phone') return this.listening ? 'Phone call on this Mac — listening' : 'Phone call on this Mac — press ⌘↩ to listen';
        if (this._state === 'computer') return 'No call on this Mac right now';
        if (this._state === 'unknown') return 'Call status unavailable';
        return 'Checking for a call…';
    }

    render() {
        return html`
            <section class="iphone-calls" aria-label="iPhone calls">
                <div class="ic-title">iPhone calls</div>
                <div class="ic-status ${this._state === 'phone' ? 'on' : ''}" role="status">${this._statusText()}</div>
                <ol class="ic-steps">
                    <li><b>iPhone:</b> Settings → Phone → Calls on Other Devices → on, tick this Mac.</li>
                    <li><b>Mac:</b> FaceTime → Settings → “Calls from iPhone” on.</li>
                    <li><b>Both:</b> same Apple ID, Wi-Fi and Bluetooth on.</li>
                    <li><b>Ringing:</b> answer on the Mac (notification, top right). Wear headphones.</li>
                    <li><b>Press ⌘↩.</b> The bar reads “Listening: phone call”.</li>
                </ol>
            </section>
        `;
    }
}

customElements.define('iphone-calls', IPhoneCalls);
