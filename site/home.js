/* kemiri.dev: theme switch and copy buttons on every page that loads it, and the homepage's self-playing demo. Pages read without it. */
// Theme switch and copy buttons. Nothing is stored.
(function () {
  var root = document.documentElement;
  var theme = document.querySelector(".theme");
  if (theme) theme.addEventListener("click", function () {
    root.dataset.chosen = "1";
    root.setAttribute("data-theme", root.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });
  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-copy]");
    if (!button) return;
    var text = button.getAttribute("data-copy");
    var done = function (ok) { var old = button.textContent; button.textContent = ok ? "Copied" : "Select it"; setTimeout(function () { button.textContent = old; }, 1600); };
    var fallback = function () {
      var area = document.createElement("textarea"); area.value = text; area.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(area); area.select();
      var ok = false; try { ok = document.execCommand("copy"); } catch (e) {} area.remove(); done(ok);
    };
    try { navigator.clipboard.writeText(text).then(function () { done(true); }, fallback); } catch (e) { fallback(); }
  });
})();
// The demo's mascots are copies of the one inline candlenut in the page.
(function () {
  var master = document.getElementById("mascot");
  if (!master) return;
  [].forEach.call(document.querySelectorAll(".mascot"), function (el) { el.appendChild(master.content.cloneNode(true)); });
})();
/**
 * One request, told in nine steps. render(step) is idempotent, so the player can jump to any step. The task list
 * lays its cards out by hand so a card can change group and size in one motion.
 */
function createStory(root, options) {
  options = options || {};
  var q = function (s) { return root.querySelector(s); };
  var chat = q(".chat"), tasks = q(".tasks"), typed = q(".typed"), composer = q(".composer");
  var me = q(".msg.me"), think = q(".msg.think"), reply = q(".msg.reply");
  var cards = { t1: q('[data-task="t1"]'), t2: q('[data-task="t2"]') };
  var chips = { t1: q('[data-chip="t1"]'), t2: q('[data-chip="t2"]') };
  var heads = { needs: q('[data-gh="needs"]'), review: q('[data-gh="review"]'), working: q('[data-gh="working"]'), done: q('[data-gh="done"]') };
  var PROMPT = me.textContent;
  var LABEL = { working: "Working", ask: "Needs you", rev: "Ready for review", done: "Done" };
  // step: chat state, then groups top to bottom as [group, [task, variant, now line]...]
  var STEPS = [
    { chat: "idle", groups: [] },
    { chat: "typed", groups: [] },
    { chat: "sent", groups: [] },
    { chat: "replied", groups: [["working", ["t1", "working", "Reading the theme tokens"], ["t2", "working", "Reproducing the login bug"]]] },
    { chat: "replied", groups: [["needs", ["t2", "ask"]], ["working", ["t1", "working", "Writing tests for the theme"]]] },
    { chat: "replied", groups: [["working", ["t1", "working", "Writing tests for the theme"], ["t2", "working", "Keeping password login"]]] },
    { chat: "replied", groups: [["review", ["t1", "rev"]], ["working", ["t2", "working", "Testing on a small screen"]]] },
    { chat: "replied", groups: [["working", ["t2", "working", "Testing on a small screen"]], ["done", ["t1", "done"]]] },
    { chat: "replied", groups: [["done", ["t1", "done"], ["t2", "done"]]] },
  ];
  var state = { step: -1, groups: [] }, typing = 0;

  function place(el, y, instant) {
    var fresh = !el.classList.contains("on") || instant;
    if (fresh) el.style.transition = "none";
    el.style.transform = "translateY(" + y + "px)";
    if (fresh) { void el.offsetHeight; el.style.transition = ""; }
    el.classList.add("on");
  }
  function layout(instant) {
    var y = 0, seen = {}, used = {};
    state.groups.forEach(function (group) {
      var head = heads[group[0]]; used[group[0]] = 1;
      head.querySelector(".cnt").textContent = group.length - 1;
      place(head, y, instant); y += 32;
      group.slice(1).forEach(function (item) {
        var card = cards[item[0]]; seen[item[0]] = 1;
        var fresh = !card.classList.contains("on") || instant;
        if (fresh) card.style.transition = "none";
        card.style.height = card.firstElementChild.offsetHeight + 2 + "px";
        place(card, y, instant);
        y += card.firstElementChild.offsetHeight + 2 + 8;
      });
      y += 8;
    });
    Object.keys(heads).forEach(function (k) { if (!used[k]) heads[k].classList.remove("on"); });
    Object.keys(cards).forEach(function (k) { if (!seen[k]) cards[k].classList.remove("on"); });
    tasks.classList.toggle("has", state.groups.length > 0);
    tasks.style.setProperty("--used", y + "px");
  }
  function setVariant(id, variant, now) {
    var card = cards[id], was = card.dataset.v;
    card.dataset.v = variant; card.className = card.className.replace(/c-\w+/, "c-" + variant);
    var chip = chips[id]; chip.dataset.v = variant; chip.className = chip.className.replace(/c-\w+/, "c-" + variant); chip.querySelector("em").textContent = LABEL[variant];
    if (now) card.querySelector(".now-t").textContent = now;
    var mascot = card.querySelector(".mascot");
    mascot.classList.toggle("working", variant === "working");
    if (variant === "done" && was !== "done" && was) { mascot.classList.remove("hop"); void mascot.offsetWidth; mascot.classList.add("hop"); }
  }
  function type() {
    clearInterval(typing); var i = 0; typed.textContent = "";
    var caret = document.createElement("i"); caret.className = "caret";
    typing = setInterval(function () {
      i += 1; typed.textContent = PROMPT.slice(0, i); typed.appendChild(caret);
      if (i >= PROMPT.length) clearInterval(typing);
    }, 30);
  }
  function render(step, how) {
    how = how || {};
    var spec = STEPS[step], forward = step === state.step + 1;
    clearInterval(typing);
    chat.dataset.chat = spec.chat;
    composer.classList.toggle("focus", spec.chat === "typed");
    if (spec.chat === "typed") { if (forward && !how.instant) type(); else typed.textContent = PROMPT; }
    me.hidden = spec.chat === "idle" || spec.chat === "typed";
    think.hidden = spec.chat !== "sent";
    reply.hidden = spec.chat !== "replied";
    state.groups = spec.groups;
    spec.groups.forEach(function (group) { group.slice(1).forEach(function (item) { setVariant(item[0], item[1], item[2]); }); });
    state.step = step;
    layout(how.instant);
    if (options.onStep) options.onStep(step);
  }
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(function () { if (state.step >= 0) layout(true); }).observe(tasks);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (state.step >= 0) layout(true); });
  return { render: render };
}
// The player: steps through the story on a timer, with a pointer for the three clicks.
(function () {
  if (!document.querySelector(".win")) return; // only the homepage has the demo
  var win = document.querySelector(".win"), cursor = win.querySelector(".cursor"), count = win.querySelector(".tab-count");
  var phases = [].slice.call(document.querySelectorAll(".phase")), capNow = document.querySelector(".cap-now"), pp = document.querySelector(".pp");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var story = createStory(win, { onStep: function (step) { count.textContent = step >= 3 ? "2" : ""; } });
  // step, how long it holds, its phase, where the pointer goes and when (ms from the step's start)
  var PLAN = [
    { step: 0, ms: 800, phase: 0 },
    { step: 1, ms: 2600, phase: 0, aim: '[data-act="send"]', at: 1300 },
    { step: 2, ms: 1400, phase: 0 },
    { step: 3, ms: 4200, phase: 1 },
    { step: 4, ms: 3200, phase: 2, aim: '[data-act="yes"]', at: 1400 },
    { step: 5, ms: 2600, phase: 2 },
    { step: 6, ms: 3800, phase: 3, aim: '[data-act="done"]', at: 1900 },
    { step: 7, ms: 1700, phase: 3 },
    { step: 8, ms: 3600, phase: 3 },
  ];
  var index = 0, elapsed = 0, playing = !reduced, visible = true, aimed = false, pressed = false, last = 0;
  var phaseMs = [0, 0, 0, 0]; PLAN.forEach(function (p) { phaseMs[p.phase] += p.ms; });

  function aim(selector) {
    var target = win.querySelector(selector); if (!target) return;
    var a = target.getBoundingClientRect(), b = win.getBoundingClientRect();
    cursor.style.transform = "translate(" + (a.left - b.left + a.width / 2 - 3) + "px," + (a.top - b.top + a.height / 2 - 2) + "px)";
    cursor.classList.add("show");
  }
  function press(selector) {
    var target = win.querySelector(selector); if (!target) return;
    target.classList.add("pressed"); cursor.classList.remove("click"); void cursor.offsetWidth; cursor.classList.add("click");
    setTimeout(function () { target.classList.remove("pressed"); }, 260);
  }
  function enter(i, instant) {
    index = i; elapsed = 0; aimed = false; pressed = false;
    var item = PLAN[i];
    if (!item.aim) cursor.classList.remove("show");
    story.render(item.step, { instant: instant });
    phases.forEach(function (el, n) { el.classList.toggle("active", n === item.phase); el.classList.toggle("past", n < item.phase); el.setAttribute("aria-current", n === item.phase ? "step" : "false"); });
    capNow.textContent = phases[item.phase].querySelector(".cap").textContent;
  }
  function paint() {
    var item = PLAN[index], before = 0;
    for (var i = 0; i < index; i++) if (PLAN[i].phase === item.phase) before += PLAN[i].ms;
    phases.forEach(function (el, n) { el.querySelector(".bar").style.transform = n === item.phase ? "scaleX(" + Math.min(1, (before + elapsed) / phaseMs[n]) + ")" : ""; });
  }
  function frame(now) {
    var dt = Math.min(100, now - (last || now)); last = now;
    if (playing && visible) {
      elapsed += dt;
      var item = PLAN[index];
      if (item.aim && !aimed && elapsed >= item.at) { aimed = true; aim(item.aim); }
      if (item.aim && !pressed && elapsed >= item.ms - 260) { pressed = true; press(item.aim); }
      if (elapsed >= item.ms) {
        if (index === PLAN.length - 1) {
          win.classList.add("reset"); playing = false;
          setTimeout(function () { enter(0, true); win.classList.remove("reset"); playing = !pp.classList.contains("paused"); }, 380);
        } else enter(index + 1);
      }
      paint();
    }
    requestAnimationFrame(frame);
  }
  phases.forEach(function (el, n) { el.addEventListener("click", function () {
    for (var i = 0; i < PLAN.length; i++) if (PLAN[i].phase === n) break;
    // Show the phase's settled picture when motion is off or the demo is paused.
    if (reduced || !playing) while (PLAN[i + 1] && PLAN[i + 1].phase === n && !PLAN[i].aim) i += 1;
    enter(i, true); paint();
  }); });
  pp.addEventListener("click", function () {
    playing = pp.classList.toggle("paused") ? false : true;
    pp.setAttribute("aria-label", playing ? "Pause the demo" : "Play the demo");
  });
  if (reduced) { pp.classList.add("paused"); pp.setAttribute("aria-label", "Play the demo"); }
  if (typeof IntersectionObserver !== "undefined") new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; }, { threshold: .15 }).observe(win);
  enter(reduced ? 3 : 0, true); paint();
  requestAnimationFrame(frame);
})();
