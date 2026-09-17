  // ---------- State ----------
  let skillSlug = null;    // slug of the currently-open skill (was `mode`)
  let stage = 1;
  let score = 0;
  let streak = 0;
  let chest = 0;            // correct answers so far this stage - visual fill only, NOT what triggers stage completion (see registerResult)
  let CHEST_GOAL = 4;       // the stage content's total question count - fill-bar denominator
  let current = {};         // current question data: {correctIndex, correctText}
  let locked = false;       // prevents double-answering

  let myChildId = null;
  let videoSearchEnabled = false;
  let skills = [];          // this child's active skills from the AI-generated plan
  let currentSkill = null;  // the skill object for the tile currently open
  let currentAttemptId = null;
  let lastCompletionResult = null;
  let currentBalance = 0;
  let selectedWatchMinutes = 5;
  let watchCountdownInterval = null;

  let currentContent = null; // {contentId, title, sharedContext, questions}
  let questionIndex = 0;

  let scratchpadOpen = false;
  let scratchpadDrawing = false;
  let scratchpadLastX = 0;
  let scratchpadLastY = 0;

  const scoreEl = document.getElementById('score');
  const streakEl = document.getElementById('streak');
  const stageEl = document.getElementById('stageNum');
  const chestFillEl = document.getElementById('chestFill');
  const qLabelEl = document.getElementById('qLabel');
  const choicesArea = document.getElementById('choicesArea');
  const feedbackEl = document.getElementById('feedback');

  function show(id){
    ['screen-select','screen-stage-pick','screen-game','screen-celebrate','screen-watch-pick','screen-watch-play','screen-content-preview'].forEach(s=>{
      document.getElementById(s).classList.toggle('hidden', s !== id);
    });
  }

  function goHome(){
    skillSlug = null;
    show('screen-select');
  }

  function randInt(min, max){
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- Treasure pouch ----------
  async function refreshPouch(){
    if(!myChildId) return;
    try{
      const data = await api.get(`/api/rewards/child/${myChildId}`);
      currentBalance = data.unredeemedMinutes;
      document.getElementById('pouchMinutesHeader').textContent = currentBalance;
      document.getElementById('pouchMinutes').textContent = currentBalance;
      const watchBtn = document.getElementById('watchVideoBtn');
      document.getElementById('watchVideoBalance').textContent = currentBalance;
      watchBtn.classList.toggle('hidden', currentBalance < 5);
    }catch(e){ /* non-fatal */ }
  }

  function popPouch(){
    ['pouchMinutesHeader','pouchMinutes'].forEach(id=>{
      const el = document.getElementById(id).parentElement;
      el.classList.remove('pouch-pop');
      void el.offsetWidth; // restart animation
      el.classList.add('pouch-pop');
    });
  }

  // ---------- Skill tiles (mode select) ----------
  // Tiles are entirely AI-decided per child (see server/lib/llm.js) - no
  // fixed taxonomy, so this renders however many skills the current plan
  // has, or an empty state if there's no plan yet.
  function renderSkillTiles(list){
    const container = document.getElementById('skillTiles');
    const emptyMsg = document.getElementById('noSkillsMsg');
    container.innerHTML = '';
    emptyMsg.classList.toggle('hidden', list.length > 0);
    list.forEach(skill => {
      const btn = document.createElement('button');
      btn.type = 'button';
      // skill.slug is already format-constrained server-side ([a-z0-9-])
      // before it's usable here as a CSS class suffix.
      btn.className = `mode-btn skill-tile skill-tile--${skill.slug}`;
      btn.innerHTML = `<span class="mode-icon"></span><p class="mode-title"></p><p class="mode-desc"></p>`;
      // AI-authored title/description - textContent only, never innerHTML.
      btn.querySelector('.mode-icon').textContent = skill.icon;
      btn.querySelector('.mode-title').textContent = skill.title;
      btn.querySelector('.mode-desc').textContent = skill.description;
      btn.addEventListener('click', () => openStagePicker(skill.slug));
      container.appendChild(btn);
    });
  }

  // ---------- Watch a video ----------
  async function openWatchPick(){
    show('screen-watch-pick');
    const errorEl = document.getElementById('watchPickError');
    const durationList = document.getElementById('watchDurationList');
    const videoList = document.getElementById('watchVideoList');
    errorEl.textContent = '';
    document.getElementById('watchPickBalance').textContent = currentBalance;

    // videoSearchEnabled was only set once at page load - if a parent turns
    // search on/off while a kid's tab is already open, that stale value
    // would silently hide/show search until a full page reload. Re-check it
    // every time this screen opens so a parent's change takes effect without
    // the kid needing to log out and back in.
    try{
      const session = await api.get('/api/auth/child/session');
      videoSearchEnabled = session.videoSearchEnabled;
    }catch(err){ /* keep last known value if this check fails */ }

    document.getElementById('searchWrap').classList.toggle('hidden', !videoSearchEnabled);
    document.getElementById('searchInput').value = '';
    document.getElementById('searchResults').innerHTML = '';

    selectedWatchMinutes = Math.min(5, currentBalance) || 5;
    durationList.innerHTML = '';
    for(let m = 5; m <= currentBalance; m += 5){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stage-btn' + (m === selectedWatchMinutes ? ' selected' : '');
      btn.innerHTML = `<p class="stage-title">${m} minutes</p>`;
      btn.addEventListener('click', () => {
        selectedWatchMinutes = m;
        Array.from(durationList.children).forEach(c => c.classList.remove('selected'));
        btn.classList.add('selected');
      });
      durationList.appendChild(btn);
    }

    const videoLabelEl = document.getElementById('watchPickVideoLabel');
    const noOptionsEl = document.getElementById('watchNoOptionsMsg');
    videoLabelEl.classList.add('hidden');
    noOptionsEl.classList.add('hidden');
    videoList.innerHTML = '<p class="form-note">Loading videos…</p>';

    let hasCuratedVideos = false;
    try{
      const data = await api.get('/api/videos/kid');
      hasCuratedVideos = data.videos.length > 0;
      videoList.innerHTML = '';
      if(hasCuratedVideos){
        videoLabelEl.classList.remove('hidden');
        data.videos.forEach(v => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'stage-btn';
          btn.innerHTML = `<p class="stage-title">🎬 ${escapeHtml(v.title)}</p>`;
          btn.addEventListener('click', () => startWatching({ videoId: v.id }, v.youtube_video_id));
          videoList.appendChild(btn);
        });
      }
    }catch(err){
      videoList.innerHTML = '';
      errorEl.textContent = err.message;
    }

    // If there's genuinely nothing to pick (no curated videos AND search is
    // off), say so clearly instead of leaving the screen looking broken -
    // duration tiles alone don't lead anywhere without a video to watch.
    if(!hasCuratedVideos && !videoSearchEnabled){
      noOptionsEl.classList.remove('hidden');
    }
  }

  async function runVideoSearch(){
    const errorEl = document.getElementById('watchPickError');
    const resultsEl = document.getElementById('searchResults');
    const query = document.getElementById('searchInput').value.trim();
    if(!query) return;
    errorEl.textContent = '';
    resultsEl.innerHTML = '<p class="form-note">Searching…</p>';
    try{
      const data = await api.get(`/api/videos/search?q=${encodeURIComponent(query)}`);
      if(data.results.length === 0){
        resultsEl.innerHTML = '<p class="form-note">No results — try a different search.</p>';
        return;
      }
      resultsEl.innerHTML = '';
      data.results.forEach(r => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'video-result-btn';
        btn.innerHTML = `
          ${r.thumbnailUrl ? `<img src="${r.thumbnailUrl}" alt="">` : ''}
          <span class="video-result-title">${escapeHtml(r.title)}</span>
        `;
        btn.addEventListener('click', () => startWatching(
          { searchYoutubeId: r.youtubeVideoId, searchTitle: r.title },
          r.youtubeVideoId
        ));
        resultsEl.appendChild(btn);
      });
    }catch(err){
      resultsEl.innerHTML = '';
      errorEl.textContent = err.message;
    }
  }

  async function startWatching(redeemParams, youtubeVideoId){
    const errorEl = document.getElementById('watchPickError');
    errorEl.textContent = '';
    try{
      await api.post(`/api/rewards/child/${myChildId}/redeem-for-watch`, { minutes: selectedWatchMinutes, ...redeemParams });
    }catch(err){
      errorEl.textContent = err.message;
      return;
    }
    await refreshPouch();

    const iframe = document.getElementById('watchIframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${youtubeVideoId}?autoplay=1&rel=0&modestbranding=1`;
    show('screen-watch-play');
    startWatchCountdown(selectedWatchMinutes * 60);
  }

  function startWatchCountdown(totalSeconds){
    let remaining = totalSeconds;
    const countdownEl = document.getElementById('watchCountdown');
    const render = () => {
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      countdownEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    };
    render();
    clearInterval(watchCountdownInterval);
    watchCountdownInterval = setInterval(() => {
      remaining -= 1;
      render();
      if(remaining <= 0){
        stopWatching();
      }
    }, 1000);
  }

  function stopWatching(){
    clearInterval(watchCountdownInterval);
    document.getElementById('watchIframe').src = '';
    goHome();
  }

  // ---------- Stage picker ----------
  async function openStagePicker(slug){
    skillSlug = slug;
    currentSkill = skills.find(s => s.slug === slug) || currentSkill;
    const stageList = document.getElementById('stageList');
    stageList.innerHTML = '<p class="form-note">Loading your progress…</p>';
    show('screen-stage-pick');

    try{
      const data = await api.get(`/api/game/skills/${encodeURIComponent(slug)}/progress`);
      stageList.innerHTML = '';
      const suggested = currentSkill && currentSkill.recommendedStartingStage;
      data.stages.forEach(s => {
        const btn = document.createElement('button');
        const classes = ['stage-btn'];
        if(s.passed) classes.push('stage-btn--passed');
        else if(s.attempted) classes.push('stage-btn--attempted');
        btn.className = classes.join(' ');
        const badge = s.stage === suggested ? ' <span class="suggested-badge">✨ Suggested</span>' : '';
        const check = s.passed ? ' ✓' : '';
        const desc = !s.hasContent ? 'Preparing…' : (s.attempted ? 'Play again' : 'Ready to play');
        btn.innerHTML = `
          <p class="stage-title">Stage ${s.stage}${check}${badge}</p>
          <p class="stage-desc">${desc}</p>
        `;
        btn.disabled = !s.hasContent;
        btn.addEventListener('click', () => startGame(slug, s.stage));
        stageList.appendChild(btn);
      });
    }catch(err){
      stageList.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  async function startGame(slug, chosenStage){
    skillSlug = slug;
    stage = chosenStage || 1;
    currentSkill = skills.find(s => s.slug === slug) || currentSkill;

    try{
      currentContent = await api.get(`/api/game/skills/${encodeURIComponent(slug)}/content?stage=${stage}`);
    }catch(err){
      feedbackEl.textContent = err.message;
      feedbackEl.className = 'feedback bad';
      goHome();
      return;
    }
    questionIndex = 0;

    // Reading/language skills share one passage across all 4 questions -
    // show it first. Other skills go straight to questions.
    if(currentContent.sharedContext){
      document.getElementById('contentPreviewTitle').textContent = currentContent.title;
      document.getElementById('contentPreviewText').textContent = currentContent.sharedContext;
      show('screen-content-preview');
      return;
    }
    await beginStageQuestions();
  }

  async function beginStageQuestions(){
    score = 0; streak = 0; chest = 0;
    CHEST_GOAL = currentContent.questions.length;
    updateStats();
    show('screen-game');

    const recapWrap = document.getElementById('contentRecapWrap');
    if(currentContent.sharedContext){
      recapWrap.classList.remove('hidden');
      recapWrap.open = false;
      document.getElementById('contentRecapText').textContent = currentContent.sharedContext;
    } else {
      recapWrap.classList.add('hidden');
    }

    try{
      const data = await api.post('/api/game/attempts/start', {
        skillSlug, stage, contentId: currentContent.contentId,
      });
      currentAttemptId = data.attemptId;
    }catch(err){
      feedbackEl.textContent = "Couldn't start this stage - please try again.";
      feedbackEl.className = 'feedback bad';
      return;
    }
    nextQuestion();
  }

  function updateStats(){
    scoreEl.textContent = score;
    streakEl.textContent = streak;
    stageEl.textContent = stage;
    chestFillEl.style.width = (chest / CHEST_GOAL * 100) + '%';
  }

  // ---------- Scratchpad ----------
  // A blank drawing surface for working problems out by hand - not graded
  // or submitted anywhere, purely for the child's own scratch work. Uses
  // Pointer Events rather than separate mouse/touch handlers so a mouse, a
  // finger, and a stylus (Apple Pencil on iPad reports as pointerType
  // "pen", including pressure) all draw through the same code path.
  const scratchpadCanvas = document.getElementById('scratchpadCanvas');
  const scratchpadCtx = scratchpadCanvas.getContext('2d');

  // The canvas's backing pixel buffer must match its displayed size *
  // devicePixelRatio for crisp lines on a Retina/iPad screen - a hidden
  // panel reports 0 size, so this only runs once the panel is visible.
  // Resizing clears any existing drawing (resize is rare - orientation
  // change - so this tradeoff favors simplicity).
  function resizeScratchpadCanvas(){
    const rect = scratchpadCanvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    scratchpadCanvas.width = Math.round(rect.width * ratio);
    scratchpadCanvas.height = Math.round(rect.height * ratio);
    scratchpadCtx.scale(ratio, ratio);
    scratchpadCtx.lineCap = 'round';
    scratchpadCtx.lineJoin = 'round';
    scratchpadCtx.strokeStyle = '#2A2118';
  }

  function clearScratchpad(){
    scratchpadCtx.clearRect(0, 0, scratchpadCanvas.width, scratchpadCanvas.height);
  }

  function toggleScratchpad(){
    scratchpadOpen = !scratchpadOpen;
    document.getElementById('scratchpadPanel').classList.toggle('hidden', !scratchpadOpen);
    if(scratchpadOpen){
      resizeScratchpadCanvas();
    }
  }

  function scratchpadPoint(e){
    const rect = scratchpadCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function scratchpadPointerDown(e){
    scratchpadDrawing = true;
    const p = scratchpadPoint(e);
    scratchpadLastX = p.x;
    scratchpadLastY = p.y;
    scratchpadCanvas.setPointerCapture(e.pointerId);
  }

  function scratchpadPointerMove(e){
    if(!scratchpadDrawing) return;
    const p = scratchpadPoint(e);
    // Apple Pencil (and some styluses) report pressure 0-1 via
    // e.pressure; a mouse/finger reports 0 while not "down" per the spec
    // but the browser still fires move events with pressure 0.5 once a
    // button/touch is active - either way this gives a natural-feeling
    // line without requiring pressure support to work at all.
    const width = e.pointerType === 'pen' && e.pressure > 0 ? 1 + e.pressure * 3 : 2.5;
    scratchpadCtx.lineWidth = width;
    scratchpadCtx.beginPath();
    scratchpadCtx.moveTo(scratchpadLastX, scratchpadLastY);
    scratchpadCtx.lineTo(p.x, p.y);
    scratchpadCtx.stroke();
    scratchpadLastX = p.x;
    scratchpadLastY = p.y;
  }

  function scratchpadPointerUp(){
    scratchpadDrawing = false;
  }

  // ---------- Question rendering (single path for every skill) ----------
  // Every skill's stage content is AI-generated ahead of time and stored
  // (see server/lib/llm.js's two-pass generate+verify pipeline) as exactly
  // 4 multiple-choice questions - there's no more per-mode generator.
  function nextQuestion(){
    locked = false;
    feedbackEl.textContent = '';
    feedbackEl.className = 'feedback';
    if(scratchpadOpen) clearScratchpad(); // fresh scratch space per question
    renderSkillQuestion();
  }

  function renderSkillQuestion(){
    const q = currentContent.questions[questionIndex];
    current = { correctIndex: q.correctIndex, correctText: q.options[q.correctIndex] };
    qLabelEl.textContent = q.question;
    choicesArea.innerHTML = '';
    q.options.forEach((opt, idx) => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.textContent = opt;
      btn.onclick = () => checkSkillAnswer(idx, btn);
      choicesArea.appendChild(btn);
    });
  }

  // correctIndex/options are sent to the browser upfront (same established
  // trust model every mode has always used) - the server only ever
  // receives a correct/incorrect boolean per answer, never the question.
  function checkSkillAnswer(selectedIndex, btnEl){
    if(locked) return;
    locked = true;
    const isCorrect = selectedIndex === current.correctIndex;
    Array.from(choicesArea.children).forEach((b, idx) => {
      b.disabled = true;
      if(idx === current.correctIndex){ b.classList.add('correct'); }
    });
    if(!isCorrect){ btnEl.classList.add('wrong'); }
    questionIndex++;
    registerResult(isCorrect);
  }

  // ---------- Shared result handling ----------
  // Awaits the /answer report before deciding what happens next - this
  // closes a real race that used to exist here: the last answer's POST and
  // the follow-up /complete call were both fired without waiting on the
  // first, so on a slower connection /complete could reach the server
  // before the final /answer write had committed, making a genuinely
  // finished stage get rejected as "incomplete" (server-side, completion
  // now requires the exact recorded answer count to match the stage's
  // question count - see server/routes/game.js).
  async function registerResult(isCorrect){
    if(isCorrect){
      score += 10;
      streak += 1;
      chest += 1;
      feedbackEl.textContent = pickPraise();
      feedbackEl.className = 'feedback good';
    } else {
      streak = 0;
      feedbackEl.textContent = `Not quite — the answer was "${current.correctText}".`;
      feedbackEl.className = 'feedback bad';
    }
    updateStats();

    // Report every answer (right or wrong) to the backend so accuracy is
    // computed server-side - never trust the client for the reward-granting
    // calculation.
    if(currentAttemptId){
      try{
        await api.post(`/api/game/attempts/${currentAttemptId}/answer`, { correct: isCorrect });
      }catch(err){ /* finishStage()'s own /complete call will surface this if it matters */ }
    }

    // Advance based on how many questions are LEFT, not how many were
    // answered correctly - content is now a fixed, finite set (see
    // renderSkillQuestion), not an infinite procedural stream like the old
    // math generators were. Gating advancement on `chest` (correct-answer
    // count) reaching CHEST_GOAL meant a single wrong answer made it
    // mathematically impossible to ever finish a stage - the game would
    // run out of questions to show and crash trying to render past the end
    // of the array. Pass/fail is decided server-side from accuracy
    // (PASS_THRESHOLD in server/routes/game.js), independent of this.
    if(questionIndex >= currentContent.questions.length){
      finishStage();
    } else {
      setTimeout(nextQuestion, isCorrect ? 900 : 1500);
    }
  }

  async function finishStage(){
    lastCompletionResult = null;
    if(currentAttemptId){
      try{
        lastCompletionResult = await api.post(`/api/game/attempts/${currentAttemptId}/complete`);
        if(lastCompletionResult.rewardEarned){
          await refreshPouch();
          popPouch();
        }
      }catch(err){
        // Never show a "you did it!" celebration for a stage the server
        // didn't actually record as complete - that's exactly what caused
        // real confusion (a child saw success, but nothing was saved and
        // the next stage never unlocked). Tell them plainly instead.
        feedbackEl.textContent = "Hmm, that didn't save properly - please try this stage again.";
        feedbackEl.className = 'feedback bad';
        return;
      }
    }
    setTimeout(showCelebration, 700);
  }

  function pickPraise(){
    const lines = ['Nice work!', 'Sharp eyes!', "You've got it!", 'Treasure secured!', 'Excellent!', 'Smooth sailing!'];
    return lines[randInt(0, lines.length - 1)];
  }

  function showCelebration(){
    const emojiEl = document.getElementById('celebrateEmoji');
    const titleEl = document.getElementById('celebrateTitle');
    const textEl = document.getElementById('celebrateText');
    const subtextEl = document.getElementById('celebrateSubtext');
    const celebrateScreen = document.getElementById('screen-celebrate');

    celebrateScreen.classList.remove('reward-earned');
    subtextEl.classList.add('hidden');
    subtextEl.textContent = '';
    emojiEl.textContent = '🏆';

    const skillTitle = currentSkill ? currentSkill.title : 'this skill';

    if(lastCompletionResult && lastCompletionResult.rewardEarned){
      celebrateScreen.classList.add('reward-earned');
      emojiEl.textContent = '🏆💰✨';
      titleEl.textContent = 'Treasure Unlocked!';
      textEl.innerHTML = `<span class="reward-banner">You earned ${lastCompletionResult.minutesEarned} minutes of screen time! 🪙</span><br>Show a grown-up your treasure pouch.`;
    } else {
      titleEl.textContent = 'Stage Complete!';
      textEl.textContent = `Great work on ${skillTitle}! Get ready for Stage ${stage + 1}.`;
      if(lastCompletionResult && lastCompletionResult.passedThreshold === false){
        subtextEl.textContent = `So close! Try Stage ${stage} again to earn your treasure minutes.`;
        subtextEl.classList.remove('hidden');
      }
    }
    show('screen-celebrate');
  }

  async function nextRound(){
    stage += 1;
    try{
      currentContent = await api.get(`/api/game/skills/${encodeURIComponent(skillSlug)}/content?stage=${stage}`);
    }catch(err){
      // The next stage's content may still be generating - send them back
      // to the stage picker, where a not-yet-ready stage shows "Preparing…"
      // and is disabled, rather than failing silently here.
      await openStagePicker(skillSlug);
      return;
    }
    questionIndex = 0;
    if(currentContent.sharedContext){
      document.getElementById('contentPreviewTitle').textContent = currentContent.title;
      document.getElementById('contentPreviewText').textContent = currentContent.sharedContext;
      show('screen-content-preview');
      return;
    }
    await beginStageQuestions();
  }

  // ---------- Bootstrap ----------
  document.addEventListener('DOMContentLoaded', async () => {
    try{
      const session = await api.get('/api/auth/child/session');
      myChildId = session.childId;
      videoSearchEnabled = session.videoSearchEnabled;
    }catch(err){
      window.location.href = '/play/index.html';
      return;
    }

    refreshPouch();

    try{
      const planData = await api.get('/api/game/learning-plan');
      skills = planData.skills || [];
    }catch(err){
      skills = [];
    }
    renderSkillTiles(skills);

    document.getElementById('scratchpadToggleBtn').addEventListener('click', toggleScratchpad);
    document.getElementById('scratchpadClearBtn').addEventListener('click', clearScratchpad);
    document.getElementById('scratchpadCloseBtn').addEventListener('click', toggleScratchpad);
    scratchpadCanvas.addEventListener('pointerdown', scratchpadPointerDown);
    scratchpadCanvas.addEventListener('pointermove', scratchpadPointerMove);
    scratchpadCanvas.addEventListener('pointerup', scratchpadPointerUp);
    scratchpadCanvas.addEventListener('pointercancel', scratchpadPointerUp);
    scratchpadCanvas.addEventListener('pointerleave', scratchpadPointerUp);
    window.addEventListener('resize', () => { if(scratchpadOpen) resizeScratchpadCanvas(); });

    document.getElementById('backToModesBtn').addEventListener('click', goHome);
    document.getElementById('changeQuestBtn').addEventListener('click', goHome);
    document.getElementById('backFromPreviewBtn').addEventListener('click', goHome);
    document.getElementById('startQuestionsBtn').addEventListener('click', beginStageQuestions);
    document.getElementById('keepSailingBtn').addEventListener('click', nextRound);
    document.getElementById('watchVideoBtn').addEventListener('click', openWatchPick);
    document.getElementById('backFromWatchPickBtn').addEventListener('click', goHome);
    document.getElementById('stopWatchingBtn').addEventListener('click', stopWatching);
    document.getElementById('searchBtn').addEventListener('click', runVideoSearch);
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
      if(e.key === 'Enter'){ e.preventDefault(); runVideoSearch(); }
    });
    document.getElementById('logoutBtn').addEventListener('click', async () => {
      await api.post('/api/auth/child/logout');
      window.location.href = '/play/index.html';
    });
  });
