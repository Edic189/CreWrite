// In-app modal dialogs.
//
// The Tauri webview (WKWebView/WebView2/WebKitGTK) does NOT implement the
// native `window.prompt` / `window.confirm` — they silently no-op (prompt
// returns null), which is why "New note"/"New folder" appeared to do nothing.
// These DOM-based dialogs work identically in the webview and in a browser.

interface PromptOptions {
  title: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
}

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
}

/** Build the overlay + card shell, returning the pieces and a close fn. */
function buildModal(title: string): {
  overlay: HTMLDivElement;
  card: HTMLDivElement;
  open: (onKey: (e: KeyboardEvent) => void) => void;
  close: (onKey: (e: KeyboardEvent) => void) => void;
} {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const card = document.createElement("div");
  card.className = "modal-card";
  const heading = document.createElement("div");
  heading.className = "modal-title";
  heading.textContent = title;
  card.appendChild(heading);
  overlay.appendChild(card);

  return {
    overlay,
    card,
    open: (onKey) => {
      document.body.appendChild(overlay);
      document.addEventListener("keydown", onKey);
    },
    close: (onKey) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    },
  };
}

/** Prompt for a line of text. Resolves to the trimmed value, or null if cancelled. */
export function promptText(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const { overlay, card, open, close } = buildModal(opts.title);

    const input = document.createElement("input");
    input.className = "modal-input";
    input.type = "text";
    input.value = opts.value ?? "";
    input.placeholder = opts.placeholder ?? "";

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "modal-btn";
    cancelBtn.textContent = "Cancel";
    const okBtn = document.createElement("button");
    okBtn.className = "modal-btn primary";
    okBtn.textContent = opts.confirmLabel ?? "Create";
    actions.append(cancelBtn, okBtn);
    card.append(input, actions);

    const finish = (result: string | null) => {
      close(onKey);
      resolve(result);
    };
    const submit = () => {
      const value = input.value.trim();
      finish(value || null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    };

    okBtn.addEventListener("click", submit);
    cancelBtn.addEventListener("click", () => finish(null));
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(null);
    });

    open(onKey);
    input.focus();
    input.select();
  });
}

/** Ask a yes/no question. Resolves true if confirmed, false otherwise. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const { overlay, card, open, close } = buildModal(opts.title);

    if (opts.message) {
      const msg = document.createElement("div");
      msg.className = "modal-message";
      msg.textContent = opts.message;
      card.appendChild(msg);
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "modal-btn";
    cancelBtn.textContent = "Cancel";
    const okBtn = document.createElement("button");
    okBtn.className = "modal-btn primary";
    okBtn.textContent = opts.confirmLabel ?? "OK";
    actions.append(cancelBtn, okBtn);
    card.appendChild(actions);

    const finish = (result: boolean) => {
      close(onKey);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };

    okBtn.addEventListener("click", () => finish(true));
    cancelBtn.addEventListener("click", () => finish(false));
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(false);
    });

    open(onKey);
    okBtn.focus();
  });
}
