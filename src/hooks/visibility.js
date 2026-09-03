/** Visibility mod: start closed; no "i" hotkey; strip Press-i hint. */
(function (root) {
  function closeVisibility() {
    if (typeof root.remixSetVisibilityOpen === "function") {
      root.remixSetVisibilityOpen(false);
      return;
    }
    const el = document.getElementById("delete-stuff-popup");
    if (el) el.hidden = true;
  }

  function stripPressIHint() {
    const close = document.getElementById("delete-stuff-close");
    if (!close) return;
    const parent = close.parentElement;
    if (!parent) return;
    parent.innerHTML = "";
    const a = document.createElement("a");
    a.id = "delete-stuff-close";
    a.href = "#";
    a.textContent = "Close";
    a.onclick = function (e) {
      e.preventDefault();
      closeVisibility();
    };
    parent.appendChild(a);
    parent.style.textAlign = "center";
  }

  function isTypingTarget(t) {
    if (!t) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function unhookIKey() {
    if (root.__mpVisIUnhooked) return;
    root.__mpVisIUnhooked = true;

    // VisibilityMod listens on document (bubble) for key === 'i'.
    // Capture-phase: block the hotkey everywhere. When typing in a field,
    // let the key reach the input first, then stop bubble so Visibility never sees it.
    document.addEventListener(
      "keydown",
      function (event) {
        if (event.key !== "i" && event.key !== "I") return;

        const t = event.target;
        if (isTypingTarget(t)) {
          // Still in capture (document → … → input). Attach a one-shot bubble
          // stopper on the field so Visibility's document listener never runs.
          t.addEventListener(
            "keydown",
            function stopVisBubble(e) {
              if (e.key === "i" || e.key === "I") {
                e.stopPropagation();
              }
            },
            { once: true, capture: false }
          );
          return;
        }

        // Not typing: kill the hotkey entirely (no toggle).
        event.stopImmediatePropagation();
        event.preventDefault();
      },
      true
    );

    // Belt-and-suspenders: also swallow on bubble if we registered after Visibility.
    document.addEventListener(
      "keydown",
      function (event) {
        if (event.key !== "i" && event.key !== "I") return;
        if (isTypingTarget(event.target)) return;
        event.stopImmediatePropagation();
        event.preventDefault();
        closeVisibility();
      },
      false
    );
  }

  function fixVisibilityUi() {
    closeVisibility();
    stripPressIHint();
    unhookIKey();
    if (typeof root.remixSyncVisibilityButton === "function") {
      root.remixSyncVisibilityButton();
    }
  }

  root.MultiplayerVisibilityFix = {
    fix: fixVisibilityUi,
    /** Alias — remixOrganizeSettings / older hooks call install(). */
    install: fixVisibilityUi,
    close: closeVisibility,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.MultiplayerVisibilityFix;
  }
})(typeof window !== "undefined" ? window : globalThis);
