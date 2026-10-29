/**
 * Connecting model providers, and trying a model (PRD 4).
 *
 * The page talks to the model gateway (services/gateway) through the demo
 * server's `/gw` proxy, with canvas-router's `GatewayClient`. A provider that
 * offers sign-in is connected by sending the browser to it and back; one that
 * takes a key is connected by pasting it once. The page never holds a key
 * after sending it, and the gateway never returns one.
 */

import { GatewayClient, GatewayError, type DataClass, type GatewayAuditEntry, type GatewayProvider, type GatewayResponse } from '@picasso/canvas-router';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const userPicker = $<HTMLSelectElement>('user');
const grid = $('providers');
const banner = $('banner');
const errorBox = $('error');
const answer = $('answer');
const providerPicker = $<HTMLSelectElement>('provider');
const modelInput = $<HTMLInputElement>('model');
const classPicker = $<HTMLSelectElement>('class');
const prompt = $<HTMLTextAreaElement>('prompt');
const auditBody = $('audit').querySelector('tbody') as HTMLElement;

// The user survives the round trip through a provider's sign-in page.
const remembered = sessionStorage.getItem('picasso.user');
if (remembered) userPicker.value = remembered;

let providers: GatewayProvider[] = [];
let lastResult: GatewayResponse | undefined;
const client = () => new GatewayClient({ baseUrl: '/gw', user: userPicker.value });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

function showError(err: unknown): void {
  errorBox.textContent = err instanceof GatewayError ? err.message.replace(/^gateway \d+: /, '') : String((err as Error).message ?? err);
}

function card(p: GatewayProvider): HTMLElement {
  const box = el('div', '', `card${p.connected ? ' connected' : ''}`);
  box.dataset.provider = p.id;
  box.append(el('div', p.name, 'name'));
  box.append(el('div', `${p.placement.replace('_', '-')} · may receive ${p.accepts.join(', ')}`, 'meta'));
  const state = el('div', '', 'state');
  if (p.auth === 'none') state.textContent = 'shared server · no sign-in needed';
  else if (p.account) state.textContent = `${p.account.method === 'oauth' ? 'signed in' : 'key connected'} · ${p.account.hint}`;
  else state.textContent = 'not connected';
  box.append(state);

  const row = el('div', '', 'row');
  if (p.auth === 'oauth' && !p.connected) {
    const button = el('button', `Sign in with ${p.name.split(' ')[0]}`);
    button.dataset.action = 'sign-in';
    button.addEventListener('click', async () => {
      try {
        sessionStorage.setItem('picasso.user', userPicker.value);
        window.location.assign(await client().signIn(p.id));
      } catch (err) {
        showError(err);
      }
    });
    row.append(button);
  }
  if (p.auth === 'api_key' && !p.connected) {
    const key = el('input');
    key.type = 'password';
    key.autocomplete = 'off';
    key.placeholder = 'API key from your account';
    const button = el('button', 'Connect');
    button.dataset.action = 'connect';
    button.addEventListener('click', async () => {
      const value = key.value.trim();
      key.value = '';
      if (!value) return;
      try {
        await client().connectKey(p.id, value);
        await refresh();
      } catch (err) {
        showError(err);
      }
    });
    row.append(key, button);
  }
  if (p.account) {
    const button = el('button', 'Disconnect');
    button.dataset.action = 'disconnect';
    button.addEventListener('click', async () => {
      try {
        await client().disconnect(p.id);
        banner.textContent = `${p.name} disconnected here. Revoke the key with ${p.name.split(' ')[0]} to end it there too.`;
        await refresh();
      } catch (err) {
        showError(err);
      }
    });
    row.append(button);
  }
  if (row.childElementCount > 0) box.append(row);
  return box;
}

function renderAudit(entries: GatewayAuditEntry[]): void {
  auditBody.replaceChildren(
    ...entries
      .slice()
      .reverse()
      .map((e) => {
        const tr = el('tr');
        for (const v of [e.at.slice(11, 19), e.provider, e.model, e.dataClass, e.outcome, e.inputTokens ? `${e.inputTokens} in / ${e.outputTokens ?? 0} out` : '']) tr.append(el('td', v));
        return tr;
      }),
  );
}

async function refresh(): Promise<void> {
  try {
    providers = await client().providers();
  } catch (err) {
    showError(err);
    providers = [];
  }
  grid.replaceChildren(...providers.map(card));
  const chosen = providerPicker.value;
  providerPicker.replaceChildren(
    ...providers.filter((p) => p.connected).map((p) => {
      const option = el('option', p.name);
      option.value = p.id;
      return option;
    }),
  );
  if (Array.from(providerPicker.options).some((o) => o.value === chosen)) providerPicker.value = chosen;
  suggestModel();
  try {
    renderAudit(await client().audit());
  } catch {
    renderAudit([]);
  }
}

function suggestModel(): void {
  const p = providers.find((x) => x.id === providerPicker.value);
  if (p && !modelInput.value) modelInput.value = p.suggested?.[0] ?? p.models?.[0] ?? '';
}

$('send').addEventListener('click', async () => {
  errorBox.textContent = '';
  answer.textContent = '';
  lastResult = undefined;
  try {
    lastResult = await client().chat({
      provider: providerPicker.value,
      model: modelInput.value.trim(),
      messages: [{ role: 'user', text: prompt.value }],
      maxTokens: 512,
      dataClass: classPicker.value as DataClass,
    });
    const r = lastResult;
    answer.textContent = r.stop === 'refusal'
      ? `${r.model} declined${r.stopDetail ? ` (${r.stopDetail})` : ''}.`
      : `${r.text}${r.stop === 'max_tokens' ? '\n[cut off at the token limit]' : ''}\n\n— ${r.model} · ${r.inputTokens} in / ${r.outputTokens} out`;
  } catch (err) {
    showError(err);
  }
  try {
    renderAudit(await client().audit());
  } catch {
    // the audit table is a convenience; the call's own outcome is shown above
  }
});

providerPicker.addEventListener('change', () => {
  modelInput.value = '';
  suggestModel();
});
userPicker.addEventListener('change', () => {
  sessionStorage.setItem('picasso.user', userPicker.value);
  banner.textContent = '';
  errorBox.textContent = '';
  void refresh();
});

// Back from a provider's sign-in page.
const params = new URLSearchParams(window.location.search);
if (params.get('connected')) banner.textContent = `Signed in: ${params.get('connected')} is connected to your account.`;
if (params.get('error')) errorBox.textContent = `Sign-in did not finish: ${params.get('error')}`;
if (params.size > 0) history.replaceState(null, '', window.location.pathname);

declare global {
  interface Window {
    __models: {
      providers(): GatewayProvider[];
      lastResult(): GatewayResponse | undefined;
      ready(): boolean;
    };
  }
}
let ready = false;
window.__models = { providers: () => providers, lastResult: () => lastResult, ready: () => ready };
void refresh().then(() => {
  ready = true;
});
