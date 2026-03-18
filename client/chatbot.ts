type AvailabilityStatus = 'in_stock' | 'out_of_stock' | 'unknown';

type Availability = {
  status: AvailabilityStatus;
  label: string;
};

type ChatRecommendation = {
  partNumber: string;
  name: string;
  price?: string;
  url: string;
  availability?: Availability;
  hierarchyGroups?: string[];
  reason?: string;
};

type ChatResponse = {
  ok: boolean;
  answer?: string;
  followUpQuestions?: string[];
  recommendations?: ChatRecommendation[];
  error?: string;
};

type ChatTrackPayload = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function emitChatTracking(eventName: string, payload: ChatTrackPayload = {}): void {
  const eventPayload = {
    event: eventName,
    feature: 'parts_advisor_chat',
    timestamp: Date.now(),
    ...payload,
  };

  if (Array.isArray(window.dataLayer)) {
    window.dataLayer.push(eventPayload);
  }

  window.dispatchEvent(
    new CustomEvent('mb_parts_chat_event', {
      detail: eventPayload,
    }),
  );
}

function buildCartUrl(url: string): string {
  try {
    const target = new URL(url);
    target.searchParams.set('ref', 'mb-parts-chatbot');
    target.searchParams.set('intent', 'cart');
    return target.toString();
  } catch {
    return url;
  }
}

function createMessageElement(role: 'user' | 'assistant', content: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = `chat-msg chat-msg-${role}`;
  node.innerHTML = `<p>${escapeHtml(content)}</p>`;
  return node;
}

function createRecommendationsElement(recommendations: ChatRecommendation[]): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-reco-list';
  wrap.innerHTML = recommendations
    .map((item) => {
      const availability = item.availability?.label ?? 'Unbekannt';
      const price = item.price?.replaceAll('*', '').trim() || 'N/A';
      const reason = item.reason?.trim() ? item.reason : 'Katalog-Match';
      const detailUrl = item.url;
      const cartUrl = buildCartUrl(item.url);
      return `
        <article class="chat-reco-card">
          <p class="chat-reco-part">${escapeHtml(item.partNumber)}</p>
          <p class="chat-reco-name">${escapeHtml(item.name || 'N/A')}</p>
          <p class="chat-reco-meta">Preis: ${escapeHtml(price)} · Status: ${escapeHtml(availability)}</p>
          <p class="chat-reco-reason">${escapeHtml(reason)}</p>
          <div class="chat-reco-actions">
            <a
              href="${escapeHtml(detailUrl)}"
              target="_blank"
              rel="noopener"
              data-track-event="chat_reco_click"
              data-track-action="view_part"
              data-track-part="${escapeHtml(item.partNumber)}"
            >Teil ansehen</a>
            <a
              href="${escapeHtml(cartUrl)}"
              target="_blank"
              rel="noopener"
              class="chat-reco-cart"
              data-track-event="chat_reco_click"
              data-track-action="add_to_cart"
              data-track-part="${escapeHtml(item.partNumber)}"
            >In den Warenkorb</a>
          </div>
        </article>
      `;
    })
    .join('');
  return wrap;
}

function createFollowUpsElement(questions: string[]): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-followups';
  wrap.innerHTML = questions.map((question) => `<p>• ${escapeHtml(question)}</p>`).join('');
  return wrap;
}

export function initPartsAdvisorChat(): void {
  const mount = document.createElement('aside');
  mount.className = 'parts-chat';
  mount.innerHTML = `
    <button id="parts-chat-toggle" type="button" class="parts-chat-toggle" aria-expanded="false" aria-controls="parts-chat-panel">
      Teile-Berater
    </button>
    <section id="parts-chat-panel" class="parts-chat-panel" hidden>
      <header class="parts-chat-head">
        <h2>Teile-Berater</h2>
        <p>Nenne Problem, Teilenummer oder Fahrzeughinweis.</p>
      </header>
      <div id="parts-chat-messages" class="parts-chat-messages" role="log" aria-live="polite" aria-atomic="false"></div>
      <form id="parts-chat-form" class="parts-chat-form">
        <label class="sr-only" for="parts-chat-input">Nachricht</label>
        <input id="parts-chat-input" name="message" type="text" minlength="2" required placeholder="z. B. A309..., Bremse vorne, W204 2012" />
        <button id="parts-chat-send" type="submit">Senden</button>
      </form>
    </section>
  `;

  document.body.appendChild(mount);

  const toggleButton = document.querySelector<HTMLButtonElement>('#parts-chat-toggle');
  const panel = document.querySelector<HTMLElement>('#parts-chat-panel');
  const form = document.querySelector<HTMLFormElement>('#parts-chat-form');
  const input = document.querySelector<HTMLInputElement>('#parts-chat-input');
  const sendButton = document.querySelector<HTMLButtonElement>('#parts-chat-send');
  const messages = document.querySelector<HTMLDivElement>('#parts-chat-messages');

  if (!toggleButton || !panel || !form || !input || !sendButton || !messages) {
    return;
  }

  messages.appendChild(
    createMessageElement(
      'assistant',
      'Ich helfe dir beim passenden Teil. Gib mir eine Teilenummer oder beschreibe Symptom + Modell/Baujahr.',
    ),
  );

  toggleButton.addEventListener('click', () => {
    const expanded = toggleButton.getAttribute('aria-expanded') === 'true';
    toggleButton.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    panel.hidden = expanded;
    if (!expanded) {
      emitChatTracking('chat_open', { source: 'toggle_button' });
    }
    if (!expanded) {
      input.focus();
    }
  });

  messages.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const anchor = target.closest<HTMLAnchorElement>('a[data-track-event]');
    if (!anchor) {
      return;
    }

    emitChatTracking(anchor.dataset.trackEvent ?? 'chat_reco_click', {
      action: anchor.dataset.trackAction ?? 'view_part',
      part_number: anchor.dataset.trackPart ?? '',
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) {
      return;
    }

    messages.appendChild(createMessageElement('user', message));
    input.value = '';
    input.focus();
    messages.scrollTop = messages.scrollHeight;

    sendButton.disabled = true;
    sendButton.textContent = '...';
    emitChatTracking('chat_submit', { message_length: message.length });

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const payload = (await response.json()) as ChatResponse;

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? `Chat failed (${response.status})`);
      }

      messages.appendChild(createMessageElement('assistant', payload.answer ?? 'Ich habe Ergebnisse gefunden.'));
      if (Array.isArray(payload.recommendations) && payload.recommendations.length > 0) {
        messages.appendChild(createRecommendationsElement(payload.recommendations));
      }
      if (Array.isArray(payload.followUpQuestions) && payload.followUpQuestions.length > 0) {
        messages.appendChild(createFollowUpsElement(payload.followUpQuestions));
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Unbekannter Fehler';
      messages.appendChild(
        createMessageElement(
          'assistant',
          `Ich konnte gerade nicht antworten (${messageText}). Bitte versuche es erneut.`,
        ),
      );
    } finally {
      sendButton.disabled = false;
      sendButton.textContent = 'Senden';
      messages.scrollTop = messages.scrollHeight;
    }
  });
}
