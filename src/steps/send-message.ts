import { Driver, clickFound, clickLeafText, openOrder } from "./driver";

/**
 * Generic Qualia "Send Message" (email with attachments) -- the caller
 * decides everything: exact subject, body, recipient emails, and exact
 * attachment files. Built 2026-10-19 for Pipeline-dashboard's closeout
 * workflow (post_closing/closeout/), which gathers all of that up front
 * from Qualia's own API, so this step makes no decisions of its own.
 *
 * Differences from actions/send-trailing-documents.ts (which this replaces
 * once the closeout workflow is live):
 * - Recipients are typed email addresses + Enter, not role-text matches
 *   against the contact dropdown. Per the user (2026-10-19) Qualia accepts a
 *   free-form address this way; send-trailing-documents.ts's 2026-08-26 note
 *   says typing an address produced no "Add" option, but that attempt never
 *   pressed Enter. Verify with composeOnly first.
 * - Attachments are matched by exact (file name, folder) pair, not "every
 *   file in Recorded documents" + a "Full Owner Policy" prefix -- the prefix
 *   match also hits the copy under "Voided Title Policies" and "Full Owner
 *   Policy #2", both seen on real orders.
 */

export interface AttachmentRef {
  /** Document name exactly as Qualia's API returns it (Document.name). */
  name: string;
  /** Document.folderPath, e.g. "Documents/Recorded documents". */
  folderPath: string;
}

export interface SendMessageInput {
  subject: string;
  body: string;
  recipients: string[];
  attachments: AttachmentRef[];
  /** Dry run only: files that would be attached but don't exist yet (e.g. a policy not issued yet). */
  pendingAttachments?: string[];
  /**
   * Every body line this workflow could have typed before. Qualia keeps an
   * unsent draft (confirmed live 2026-10-22: the lender email reopened with
   * the owner email's recipient, text and deed still in it), so leading body
   * paragraphs matching these are deleted, keeping Qualia's own signature.
   */
  clearBodyLines?: string[];
  composeOnly?: boolean;
}

export interface SendMessageResult {
  status: "sent" | "composed" | "error";
  recipientChips?: string[];
  attachments?: string[];
  bodyPreview?: string;
  /** base64 PNG of the compose popup, composeOnly runs only. */
  screenshot?: string;
  detail?: string;
}

const POPUP = "sendemailpopup";
const RECIPIENTS_MARK = "data-closeout-recipients";

function folderLeaf(folderPath: string): string {
  const parts = folderPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? folderPath;
}

/**
 * Page-side helper for the attachment strip (file chips between the body
 * editor and the Send row). Called with 'mark': tags the first chip's remove
 * control and returns the chip's text (null when none); with 'list': returns
 * JSON {files: [chip texts], html: strip markup (truncated, for the log)}.
 * A "remove control" is a visible element in that band whose own text is a
 * cross (✖ × ✕) or whose class says remove/delete/close/times.
 */
const FILE_STRIP_JS = `function(mode) {
  var p = document.querySelector('${POPUP}');
  var ed = p.querySelector('.ql-container') || p.querySelector('.ql-editor');
  var top = ed ? ed.getBoundingClientRect().bottom - 2 : 0;
  var sendBtn = null;
  p.querySelectorAll('*').forEach(function(el) {
    if (!sendBtn && el.children.length === 0 && (el.textContent || '').trim() === 'Send' && el.offsetParent !== null) sendBtn = el;
  });
  var bottom = sendBtn ? sendBtn.getBoundingClientRect().top + 2 : Infinity;
  var inBand = function(el) {
    var r = el.getBoundingClientRect();
    return el.offsetParent !== null && r.top >= top && r.bottom <= bottom && r.width > 0;
  };
  var isRemove = function(el) {
    var own = el.children.length === 0 ? (el.textContent || '').trim() : '';
    var cls = typeof el.className === 'string' ? el.className : '';
    return /^[\\u2716\\u00d7\\u2715]$/.test(own) || /(^|[\\s-])(remove|delete|close|times)([\\s-]|$)/i.test(cls);
  };
  var controls = Array.from(p.querySelectorAll('*')).filter(function(el) { return inBand(el) && isRemove(el); });
  // Keep only the innermost control per chip.
  controls = controls.filter(function(c) { return !controls.some(function(o) { return o !== c && c.contains(o); }); });
  var chipOf = function(c) {
    var el = c;
    while (el.parentElement && el.parentElement !== p && (el.parentElement.textContent || '').trim().length < 160 &&
           el.parentElement.querySelectorAll('*').length < 40) el = el.parentElement;
    return (el.textContent || '').replace(/[\\u2716\\u00d7\\u2715]/g, '').replace(/\\s+/g, ' ').trim();
  };
  if (mode === 'mark') {
    if (!controls.length) return null;
    controls[0].setAttribute('data-wf-target', 'leftover-file');
    return chipOf(controls[0]) || '(file)';
  }
  var strip = controls.length ? controls[0].closest('div') : null;
  return JSON.stringify({
    files: controls.map(chipOf),
    html: strip && strip.parentElement ? strip.parentElement.outerHTML.slice(0, 1500) : ''
  });
}`;

/**
 * Qualia keeps unsent drafts: remove every recipient / CC / BCC chip and
 * every attached-file chip left in the popup before filling it in. Both
 * are Semantic UI labels with a delete icon; the popup's own close (X)
 * is a different element and never matched.
 */
async function clearLeftovers(d: Driver): Promise<{ removed: string[]; error?: string }> {
  const removed: string[] = [];
  for (let i = 0; i < 40; i++) {
    const chip = await d.evaluate<string | null>(`
      (function() {
        var icons = Array.from(document.querySelectorAll(
          '${POPUP} .ui.label .delete.icon, ${POPUP} .ui.label i.delete, ${POPUP} .ui.label .remove.icon'
        )).filter(function(e) { return e.offsetParent !== null; });
        if (!icons.length) return null;
        icons[0].setAttribute('data-wf-target', 'leftover');
        var chip = icons[0].closest('.ui.label');
        return ((chip && chip.textContent) || '').replace(/\\s+/g, ' ').trim() || '(chip)';
      })()
    `);
    if (chip === null) break;
    await d.click(`[data-wf-target="leftover"]`, { via: "dom", label: `Remove leftover: ${chip}` });
    await d.evaluate(`(function(){ var e = document.querySelector('[data-wf-target="leftover"]'); if (e) e.removeAttribute('data-wf-target'); })()`);
    await d.sleep(300);
    removed.push(chip);
  }
  // Attached files are a different widget from the recipient labels (a strip
  // of file chips with their own ✖, between the body and the Send row --
  // seen live 2026-10-23: the owner email's deed stayed attached to the lender
  // email). Remove every chip in that strip.
  for (let i = 0; i < 20; i++) {
    const file = await d.evaluate<string | null>(`(${FILE_STRIP_JS})('mark')`);
    if (file === null) break;
    await d.click(`[data-wf-target="leftover-file"]`, { via: "dom", label: `Remove leftover file: ${file}` });
    await d.evaluate(`(function(){ var e = document.querySelector('[data-wf-target="leftover-file"]'); if (e) e.removeAttribute('data-wf-target'); })()`);
    await d.sleep(400);
    removed.push(`file: ${file}`);
  }
  if (removed.length) d.note(`Cleared ${removed.length} leftover chip(s) from an earlier draft: ${removed.join(", ")}`);
  // Anything chip-like still there (an attachment rendered differently) is
  // reported with its markup, so the next run can handle it -- never sent over.
  const remaining = await d.evaluate<string>(`
    (function() {
      var p = document.querySelector('${POPUP}');
      var labels = Array.from(p.querySelectorAll('.ui.label')).filter(function(e) { return e.offsetParent !== null; });
      return JSON.stringify(labels.map(function(e) { return e.outerHTML.slice(0, 300); }));
    })()
  `);
  const left = JSON.parse(remaining) as string[];
  if (left.length) return { removed, error: `Couldn't clear ${left.length} leftover chip(s): ${left.join(" | ")}` };
  return { removed };
}

export async function sendMessageStep(d: Driver, orderId: string, input: SendMessageInput): Promise<SendMessageResult> {
  if (input.recipients.length === 0) return { status: "error", detail: "No recipients given." };
  if (input.attachments.length === 0) return { status: "error", detail: "No attachments given." };

  await openOrder(d, orderId, "dashboard");
  await d.sleep(3_000);

  d.note("Opening Send Message");
  const openResult = await clickLeafText(d, "Send Message");
  if (openResult !== "clicked") return { status: "error", detail: `"Send Message" button ${openResult}.` };
  if (!(await d.waitFor(`!!document.querySelector('${POPUP}')`, 20_000))) {
    return { status: "error", detail: "Send Message popup never appeared." };
  }
  await d.sleep(1_000);

  const cleared = await clearLeftovers(d);
  if (cleared.error) return { status: "error", detail: cleared.error };

  // Subject -- raw value-set + input event, same as send-trailing-documents.ts.
  d.note(`Subject: ${input.subject}`);
  await d.show(`${POPUP} input[data-schema-key="subject"]`, `Fill subject: ${input.subject}`);
  const subjectResult = await d.evaluate<string>(`
    (function() {
      var input = document.querySelector('${POPUP} input[data-schema-key="subject"]');
      if (!input) return 'no subject input';
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(input.subject)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'filled';
    })()
  `);
  if (subjectResult !== "filled") return { status: "error", detail: `Subject fill failed: ${subjectResult}` };

  // Body -- Quill editor pre-filled with Qualia's signature; type our text
  // at the very start with real key events (Quill ignores raw value-sets).
  d.note("Typing the body above the signature");
  if (!(await d.waitFor(`!!document.querySelector('${POPUP} .ql-editor')`, 10_000))) {
    return { status: "error", detail: "Body editor (.ql-editor) not found." };
  }
  await d.click(`${POPUP} .ql-editor`, { label: "Click into the body" });
  // Qualia keeps unsent drafts: delete our own leftover lines above the
  // signature, but KEEP the blank line right before it and type into that --
  // deleting it too made the typing land in the signature's first line and
  // inherit its bold (seen live 2026-10-23, 2026-MO-410).
  const bodyState = await d.evaluate<string>(`
    (function() {
      var norm = function(t) { return (t || '').replace(/[\\s\\u00a0]+/g, ' ').trim(); };
      var known = ${JSON.stringify(input.clearBodyLines ?? [])}.map(norm);
      var editor = document.querySelector('${POPUP} .ql-editor');
      var kids = Array.from(editor.children);
      var blank = function(el) { return norm(el.textContent) === ''; };
      var sig = kids.findIndex(function(el) { return !blank(el) && known.indexOf(norm(el.textContent)) === -1; });
      if (sig === -1) sig = kids.length;
      var blankStart = sig;
      while (blankStart > 0 && blank(kids[blankStart - 1])) blankStart--;
      var leftover = kids.slice(0, blankStart).filter(function(el) { return !blank(el); }).length;
      var line, inserted = false, cleaned = false;
      if (blankStart < sig) {
        line = kids[blankStart];
      } else {
        line = document.createElement('p');
        line.innerHTML = '<br>';
        editor.insertBefore(line, kids[sig] || null);
        inserted = true;
      }
      if (line.innerHTML !== '<br>') { line.innerHTML = '<br>'; cleaned = true; } // drop bold etc.
      line.setAttribute('data-wf-typeline', '1');
      return JSON.stringify({ leftover: leftover, sig: sig, blankStart: blankStart, total: kids.length,
                              known: known.length, inserted: inserted, cleaned: cleaned,
                              first: kids.slice(0, 3).map(function(el) { return el.tagName + ':' + norm(el.textContent).slice(0, 60); }) });
    })()
  `);
  const body = JSON.parse(bodyState) as { leftover: number; known: number; inserted: boolean; cleaned: boolean; first: string[] };
  d.note(`Body check: ${body.leftover} leftover line(s), ${body.known} known lines, blank line ${body.inserted ? "inserted" : "kept"}${body.cleaned ? " (formatting cleared)" : ""}, starts with ${JSON.stringify(body.first)}`);
  await d.sleep(300); // let Quill sync the DOM changes

  const placeCaret = (selectLeftover: boolean) => d.evaluate<string>(`
    (function() {
      var editor = document.querySelector('${POPUP} .ql-editor');
      var line = editor.querySelector('[data-wf-typeline]') || editor.firstElementChild;
      var range = document.createRange();
      if (${selectLeftover}) { range.setStart(editor, 0); range.setEndBefore(line); }
      else { range.setStart(line, 0); range.collapse(true); }
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return 'ok';
    })()
  `);
  if (body.leftover > 0) {
    d.note(`Removing ${body.leftover} leftover line(s) from an earlier draft`);
    await placeCaret(true);
    await d.sleep(300); // Quill picks up the selection on selectionchange (async)
    await d.press("Backspace");
    await d.sleep(300);
  }
  await placeCaret(false);
  await d.sleep(300);
  // Each line then Enter: the last Enter leaves exactly one blank line
  // before the signature.
  for (const line of input.body.split("\n")) {
    if (line) await d.type(line, `Type: ${line.slice(0, 60)}`);
    await d.press("Enter");
  }
  await d.sleep(500);
  const boldCheck = await d.evaluate<string>(`
    (function() {
      var known = ${JSON.stringify(input.body.split("\n").filter((l) => l.trim()))};
      var bold = Array.from(document.querySelectorAll('${POPUP} .ql-editor > *')).filter(function(el) {
        var t = (el.textContent || '').trim();
        return known.indexOf(t) !== -1 && !!el.querySelector('strong, b');
      });
      return bold.map(function(el) { return (el.textContent || '').slice(0, 40); }).join(' | ');
    })()
  `);
  if (boldCheck) {
    return { status: "error", detail: `Typed text came out bold (inherited formatting): ${boldCheck}` };
  }
  const bodyPreview = await d.evaluate<string>(
    `(document.querySelector('${POPUP} .ql-editor').innerText || '').slice(0, 600)`
  );

  // Recipients -- find the dropdown that owns the "Recipients" placeholder
  // and tag it, since the placeholder text disappears after the first chip.
  const marked = await d.evaluate<string>(`
    (function() {
      var panel = document.querySelector('${POPUP}');
      var leaf = null;
      panel.querySelectorAll('*').forEach(function(el) {
        if (!leaf && el.children.length === 0 && (el.textContent || '').trim() === 'Recipients') leaf = el;
      });
      if (!leaf) return 'no Recipients element';
      var dd = leaf.closest('.ui.dropdown') || leaf.parentElement;
      dd.setAttribute('${RECIPIENTS_MARK}', '1');
      return dd.querySelector('input.search') ? 'marked' : 'marked-no-search-input';
    })()
  `);
  if (marked !== "marked") return { status: "error", bodyPreview, detail: `Recipients field: ${marked}` };

  const chips = async (): Promise<string[]> =>
    JSON.parse(
      await d.evaluate<string>(`
        (function() {
          var dd = document.querySelector('[${RECIPIENTS_MARK}]');
          return JSON.stringify(Array.from(dd.querySelectorAll('.ui.label, a.label')).map(function(l) {
            return (l.textContent || '').replace(/\\s+/g, ' ').trim();
          }));
        })()
      `)
    );

  for (const email of input.recipients) {
    d.note(`Adding recipient ${email}`);
    const before = (await chips()).length;
    // Focus the search input directly: Qualia's "Recipients" placeholder
    // (div.default.text) sits on top of it, so a real mouse click lands on the
    // placeholder -- Playwright refuses that click too (seen 2026-10-22).
    await d.show(`[${RECIPIENTS_MARK}]`, "Recipients");
    await d.evaluate(`(function(){ var i = document.querySelector('[${RECIPIENTS_MARK}] input.search'); i.focus(); return !!i; })()`);
    await d.type(email, `Type recipient ${email}`);
    await d.sleep(800);
    await d.press("Enter");
    await d.sleep(800);
    const after = await chips();
    if (after.length !== before + 1) {
      return {
        status: "error",
        recipientChips: after,
        bodyPreview,
        detail: `Recipient "${email}" was not added (chips ${before} -> ${after.length}).`,
      };
    }
  }
  const recipientChips = await chips();
  await d.press("Escape").catch(() => {});
  await d.sleep(500);

  // "via" -> "email with attachments" (two-step dropdown, see
  // send-trailing-documents.ts for the live-verified selectors).
  d.note('Switching to "email with attachments"');
  let via = await clickLeafText(d, "email with attachments", POPUP);
  if (via !== "clicked") {
    const opened = await clickFound(d, `(function() {
        var all = document.querySelector('${POPUP}').querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          var txt = el.children.length === 0 ? (el.textContent || '').trim() : '';
          if (txt.indexOf('email using secure document portal') !== -1 && el.offsetParent !== null) return el;
        }
        return null;
      })()`, 'Open the "via" dropdown');
    if (opened !== "clicked") return { status: "error", recipientChips, bodyPreview, detail: `"via" dropdown: ${opened}` };
    await d.sleep(800);
    via = await clickLeafText(d, "email with attachments", POPUP);
    if (via !== "clicked") return { status: "error", recipientChips, bodyPreview, detail: `"email with attachments": ${via}` };
  }
  await d.sleep(1_000);

  // Attachments -- each picker item's text is "<file name><folder leaf>"
  // concatenated (optionally whitespace-separated). Require an exact match
  // so "Full Owner Policy" doesn't also hit "Full Owner Policy #2" or the
  // copy in "Voided Title Policies".
  d.note(`Attaching ${input.attachments.map((a) => a.name).join(" + ")}`);
  const wanted = input.attachments.map((a) => ({ name: a.name, leaf: folderLeaf(a.folderPath) }));
  const attachRaw = await d.evaluate<string>(`
    (function() {
      var menu = document.querySelector('${POPUP} .scrolling.menu');
      if (!menu) return JSON.stringify({ error: 'no attachment picker found' });
      var norm = function(s) { return (s || '').replace(/\\s+/g, ' ').trim(); };
      var items = Array.from(menu.children).map(function(it, i) { return { i: i, t: norm(it.textContent) }; });
      var wanted = ${JSON.stringify(wanted)};
      var matches = [], missing = [], ambiguous = [];
      wanted.forEach(function(w) {
        var name = norm(w.name), leaf = norm(w.leaf);
        var hits = items.filter(function(it) {
          return it.t === name + leaf || it.t === name + ' ' + leaf;
        });
        if (hits.length === 0) {
          var near = items.filter(function(it) { return it.t.indexOf(name) === 0; }).map(function(it) { return it.t; });
          missing.push({ name: w.name, folder: w.leaf, near: near.slice(0, 5) });
        } else if (hits.length > 1) {
          ambiguous.push(w.name);
        } else {
          matches.push({ name: w.name, index: hits[0].i, text: hits[0].t });
        }
      });
      return JSON.stringify({ matches: matches, missing: missing, ambiguous: ambiguous });
    })()
  `);
  let attach: { matches?: { name: string; index: number; text: string }[]; missing?: unknown[]; ambiguous?: string[]; error?: string };
  try {
    attach = JSON.parse(attachRaw);
  } catch {
    return { status: "error", recipientChips, bodyPreview, detail: `Attachment picker failed: ${attachRaw}` };
  }
  if (attach.error) return { status: "error", recipientChips, bodyPreview, detail: attach.error };
  if ((attach.missing?.length ?? 0) > 0 || (attach.ambiguous?.length ?? 0) > 0) {
    return {
      status: "error",
      recipientChips,
      bodyPreview,
      detail: `Attachments not matched exactly: missing=${JSON.stringify(attach.missing)} ambiguous=${JSON.stringify(attach.ambiguous)}`,
    };
  }
  const attached: string[] = [];
  for (const m of attach.matches ?? []) {
    const r = await clickFound(
      d,
      `(document.querySelector('${POPUP} .scrolling.menu') || { children: [] }).children[${m.index}] || null`,
      `Attach "${m.name}"`
    );
    if (r !== "clicked") {
      return { status: "error", recipientChips, attachments: attached, bodyPreview, detail: `Attachment "${m.name}": ${r}` };
    }
    attached.push(m.text);
  }
  await d.sleep(1_000);

  // Exactly our files must be attached -- anything else is a leftover the
  // cleanup missed; stop before Send rather than mail the wrong document.
  const strip = JSON.parse(await d.evaluate<string>(`(${FILE_STRIP_JS})('list')`)) as { files: string[]; html: string };
  d.note(`Attached now: ${JSON.stringify(strip.files)}`);
  if (strip.files.length !== attached.length) {
    return {
      status: "error",
      recipientChips,
      attachments: attached,
      bodyPreview,
      detail: `Expected ${attached.length} attached file(s), the popup shows ${strip.files.length}: ` +
        `${JSON.stringify(strip.files)} -- strip markup: ${strip.html}`,
    };
  }

  if (input.composeOnly) {
    if (input.pendingAttachments?.length) {
      await d.show(
        `${POPUP} .scrolling.menu`,
        `Would also attach once issued: ${input.pendingAttachments.join(", ")} (dry run)`
      );
    }
    d.note("Dry run: everything filled in, not sending");
    const screenshot = await d.screenshot(POPUP).catch(() => undefined);
    return {
      status: "composed",
      recipientChips,
      attachments: attached,
      bodyPreview,
      screenshot,
      detail: "[composeOnly] nothing sent",
    };
  }

  await d.commit(`Send this email to ${input.recipients.join(", ")}`);
  d.note("Clicking Send");
  const sendResult = await clickLeafText(d, "Send", POPUP);
  if (sendResult !== "clicked") {
    return { status: "error", recipientChips, attachments: attached, detail: `"Send" button: ${sendResult}` };
  }
  // Verify the popup actually closed rather than trusting the click.
  const closed = await d.waitFor(
    `(function(){ var p = document.querySelector('${POPUP}'); return !p || p.offsetParent === null; })()`,
    30_000
  );
  if (!closed) {
    return { status: "error", recipientChips, attachments: attached, detail: "Clicked Send but the compose popup is still open." };
  }
  return { status: "sent", recipientChips, attachments: attached, bodyPreview };
}
