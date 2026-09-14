  // ---------- State ----------
  let mode = null;
  let stage = 1;
  const MAX_STAGE = 3;
  let score = 0;
  let streak = 0;
  let chest = 0;          // 0-10 correct answers per stage
  const CHEST_GOAL = 10;
  let current = {};        // current question data
  let locked = false;      // prevents double-answering
  let ansBoxes = [];        // the 3 answer-digit inputs, index 0 = hundeds, 2 = ones
  let carryBoxes = [];      // the small carry/borrow scratch boxes
  let lastFocusedBox = null;
  let missingValue = "";   // free-typed value for Stage 3 missing-number puzzles

  let myChildId = null;
  let videoSearchEnabled = false;
  let currentAttemptId = null;
  let lastCompletionResult = null;
  let currentBalance = 0;
  let selectedWatchMinutes = 5;
  let watchCountdownInterval = null;

  const STAGE_INFO = {
    round: {
      1: 'Friendly 2-digit numbers, rounded to the nearest 10 or 100',
      2: '3-digit numbers — watch for tricky rollovers',
      3: 'Word problems mixed in — the GATE tier!',
    },
    addsub: {
      1: '2-digit warm-up',
      2: '3-digit numbers with regrouping',
      3: 'Word problems & missing-number puzzles — the GATE tier!',
    },
  };

  const scoreEl = document.getElementById('score');
  const streakEl = document.getElementById('streak');
  const stageEl = document.getElementById('stageNum');
  const chestFillEl = document.getElementById('chestFill');
  const qLabelEl = document.getElementById('qLabel');
  const qValueEl = document.getElementById('qValue');
  const choicesArea = document.getElementById('choicesArea');
  const inputArea = document.getElementById('inputArea');
  const columnMathWrap = document.getElementById('columnMathWrap');
  const singleValueWrap = document.getElementById('singleValueWrap');
  const missingInputEl = document.getElementById('missingInput');
  const regroupHintEl = document.getElementById('regroupHint');
  const feedbackEl = document.getElementById('feedback');
  const submitBtn = document.getElementById('submitBtn');

  function show(id){
    ['screen-select','screen-stage-pick','screen-game','screen-celebrate','screen-watch-pick','screen-watch-play'].forEach(s=>{
      document.getElementById(s).classList.toggle('hidden', s !== id);
    });
  }

  function goHome(){
    mode = null;
    show('screen-select');
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

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- Watch a video ----------
  async function openWatchPick(){
    show('screen-watch-pick');
    const errorEl = document.getElementById('watchPickError');
    const durationList = document.getElementById('watchDurationList');
    const videoList = document.getElementById('watchVideoList');
    errorEl.textContent = '';
    document.getElementById('watchPickBalance').textContent = currentBalance;

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

    videoList.innerHTML = '<p class="form-note">Loading videos…</p>';
    try{
      const data = await api.get('/api/videos/kid');
      if(data.videos.length === 0){
        videoList.innerHTML = '<p class="form-note">No approved videos yet — ask a grown-up to add some!</p>';
        return;
      }
      videoList.innerHTML = '';
      data.videos.forEach(v => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'stage-btn';
        btn.innerHTML = `<p class="stage-title">🎬 ${escapeHtml(v.title)}</p>`;
        btn.addEventListener('click', () => startWatching({ videoId: v.id }, v.youtube_video_id));
        videoList.appendChild(btn);
      });
    }catch(err){
      videoList.innerHTML = '';
      errorEl.textContent = err.message;
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
  async function openStagePicker(m){
    mode = m;
    const stageList = document.getElementById('stageList');
    stageList.innerHTML = '<p class="form-note">Loading your progress…</p>';
    show('screen-stage-pick');
    try{
      const data = await api.get(`/api/game/progress?mode=${m}`);
      const available = data.availableStage;
      stageList.innerHTML = '';
      for(let s = 1; s <= available; s++){
        const btn = document.createElement('button');
        btn.className = 'stage-btn';
        btn.innerHTML = `
          <p class="stage-title">Stage ${s}${s === MAX_STAGE ? ' (GATE)' : ''}</p>
          <p class="stage-desc">${STAGE_INFO[m][s]}</p>
        `;
        btn.addEventListener('click', () => startGame(m, s));
        stageList.appendChild(btn);
      }
    }catch(err){
      stageList.innerHTML = `<p class="form-error">${err.message}</p>`;
    }
  }

  async function startAttempt(m, s){
    const data = await api.post('/api/game/attempts/start', { gameMode: m, stage: s });
    currentAttemptId = data.attemptId;
  }

  async function startGame(m, chosenStage){
    mode = m;
    stage = chosenStage || 1;
    score = 0; streak = 0; chest = 0;
    updateStats();
    show('screen-game');
    if(mode === 'round'){
      choicesArea.classList.remove('hidden');
      inputArea.classList.add('hidden');
      qValueEl.classList.remove('hidden');
    } else {
      choicesArea.classList.add('hidden');
      inputArea.classList.remove('hidden');
      qValueEl.classList.add('hidden');
      buildKeypad();
    }
    try{
      await startAttempt(mode, stage);
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

  // ---------- Question generators ----------
  function randInt(min, max){
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function roundTo(num, place){
    return Math.round(num / place) * place;
  }

  function makeRoundingQuestion(){
    // Stage 1: friendly 2-digit (nearest 10) / 3-digit (nearest 100) numbers.
    // Stage 2+: numbers are always 3-digit, so rounding to the nearest 10
    // sometimes rolls over into a new hundred (e.g. 995 -> 1000).
    const use3Digit = stage >= 2;
    const place = Math.random() < 0.5 ? 10 : 100;
    let num;
    if(place === 10){
      num = use3Digit ? randInt(101, 998) : randInt(11, 98);
    } else {
      num = randInt(105, 985);
      // avoid exact multiples of 100 so it stays interesting
      if(num % 100 === 0) num += 5;
    }
    const correct = roundTo(num, place);

    // build 3 distinct wrong choices near the correct one
    const distractors = new Set();
    const step = place;
    const candidates = [correct - step, correct + step, correct - 2*step, correct + 2*step, num];
    for(const c of candidates){
      if(c !== correct && c >= 0){ distractors.add(c); }
      if(distractors.size >= 3) break;
    }
    const options = [correct, ...Array.from(distractors).slice(0,3)];
    // shuffle
    for(let i = options.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i+1));
      [options[i], options[j]] = [options[j], options[i]];
    }

    // Stage 3 (GATE tier): about half the questions become word problems.
    const isWord = stage === MAX_STAGE && Math.random() < 0.5;

    current = { num, place, correct, options };
    qLabelEl.textContent = isWord ? pickRoundingWordProblem(num, place) : `Round to the nearest ${place}:`;
    qValueEl.innerHTML = num;

    choicesArea.innerHTML = '';
    options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.textContent = opt;
      btn.onclick = () => checkRoundingAnswer(opt, btn);
      choicesArea.appendChild(btn);
    });
  }

  function pickRoundingWordProblem(num, place){
    const templates = [
      `A pirate counted ${num} seashells on the beach. About how many is that, rounded to the nearest ${place}?`,
      `The old map shows ${num} paces to the buried chest. Rounded to the nearest ${place}, about how many paces?`,
      `${num} parrots live on Squawk Island. About how many parrots is that, rounded to the nearest ${place}?`,
      `The ship sailed ${num} miles this week. Rounded to the nearest ${place}, about how many miles?`
    ];
    return templates[randInt(0, templates.length - 1)];
  }

  function makeAddSubQuestion(){
    if(stage === 1){
      // Stage 1: friendly 2-digit warm-up
      const q = generateAddSubNumbers(10, 99);
      buildStraightAddSub(q, straightLabel(q.isAdd), straightHint(q.isAdd));
    } else if(stage === 2){
      // Stage 2: always 3-digit, so regrouping across two columns is common
      const q = generateAddSubNumbers(100, 300);
      buildStraightAddSub(q, straightLabel(q.isAdd), 'Three digits now — watch for regrouping across two columns!');
    } else {
      // Stage 3 (GATE tier): mix real-world word problems with
      // missing-number puzzles that need inverse-operation thinking
      if(Math.random() < 0.5){
        const q = generateAddSubNumbers(100, 300);
        buildStraightAddSub(q, pickAddSubWordProblem(q), straightHint(q.isAdd));
      } else {
        makeMissingNumberQuestion();
      }
    }
  }

  // Picks three numbers and works out whether this is an addition or
  // subtraction problem, keeping subtraction non-negative and friendly.
  function generateAddSubNumbers(min, max){
    const isAdd = Math.random() < 0.6; // slightly favor addition early
    let a = randInt(min, max);
    let b = randInt(min, max);
    let c = randInt(min, max);
    let answer;
    if(isAdd){
      answer = a + b + c;
    } else {
      [a, b, c] = [a, b, c].sort((x, y) => y - x);
      answer = a - b - c;
      if(answer < 0){ b = 0; c = 0; answer = a; } // ultra-rare guard
    }
    return { a, b, c, isAdd, answer };
  }

  function straightLabel(isAdd){
    return isAdd ? 'Add these three treasure piles:' : 'Subtract to see what treasure is left:';
  }
  function straightHint(isAdd){
    return isAdd
      ? 'Dashed boxes are for carrying — fill them in as you regroup!'
      : 'Dashed boxes are for borrowing — jot what you regroup!';
  }

  function pickAddSubWordProblem({ a, b, c, isAdd }){
    const addTemplates = [
      `Captain Zara found ${a} gold coins, ${b} silver coins, and ${c} bronze coins. How many coins did she find in total?`,
      `The crew loaded ${a} crates of spice, ${b} crates of silk, and ${c} crates of tea onto the ship. How many crates in all?`,
      `Three islands hide ${a}, ${b}, and ${c} pieces of treasure. How many pieces of treasure altogether?`
    ];
    const subTemplates = [
      `The chest held ${a} coins. The crew spent ${b} coins on rope and ${c} coins on maps. How many coins are left?`,
      `A ship started with ${a} barrels of water. During the voyage, ${b} barrels were used and ${c} more spoiled. How many barrels remain?`,
      `There were ${a} pearls in the vault. The captain gave away ${b} pearls and lost ${c} pearls overboard. How many pearls remain?`
    ];
    const pool = isAdd ? addTemplates : subTemplates;
    return pool[randInt(0, pool.length - 1)];
  }

  // Straight computation and word problems both use the column grid —
  // the story just changes the label above it, not the math underneath.
  function buildStraightAddSub(q, label, hint){
    current = { qType: 'straight', ...q };
    qLabelEl.textContent = label;
    regroupHintEl.textContent = hint;
    qValueEl.classList.add('hidden');
    qValueEl.classList.remove('equation');
    columnMathWrap.classList.remove('hidden');
    singleValueWrap.classList.add('hidden');
    submitBtn.disabled = false;
    buildColumnMath(q.a, q.b, q.c, q.isAdd, q.answer);
  }

  // Stage 3 GATE puzzle: shows an addition equation with one addend
  // hidden and asks the child to work out what it must be.
  function makeMissingNumberQuestion(){
    const a = randInt(20, 250);
    const b = randInt(20, 250);
    const c = randInt(20, 250);
    const total = a + b + c;
    const values = [a, b, c];
    const hideIndex = randInt(0, 2);
    const missingAnswer = values[hideIndex];
    const shown = values.map((v, i) => (i === hideIndex ? '▢' : v));
    const equation = `${shown[0]} + ${shown[1]} + ${shown[2]} = ${total}`;

    current = { qType: 'missing', missingAnswer, total };
    qLabelEl.textContent = 'Find the missing number:';
    regroupHintEl.textContent = 'Think: what number completes the equation?';
    qValueEl.classList.remove('hidden');
    qValueEl.classList.add('equation');
    qValueEl.textContent = equation;
    columnMathWrap.classList.add('hidden');
    singleValueWrap.classList.remove('hidden');
    missingValue = '';
    missingInputEl.value = '';
    missingInputEl.classList.remove('correct', 'wrong');
    submitBtn.disabled = false;
  }

  // Renders the three numbers stacked by place value (hundreds/tens/ones)
  // with small carry/borrow scratch boxes above, and one answer box per
  // column — so regrouping is something she can see and write, not just say.
  function buildColumnMath(a, b, c, isAdd, answer){
    const places = ['H', 'T', 'O'];
    const digitsOf = n => n.toString().padStart(3, ' ').split('');
    const da = digitsOf(a), db = digitsOf(b), dc = digitsOf(c);
    const opSym = isAdd ? '+' : '−';

    const colTable = document.getElementById('colTable');
    colTable.innerHTML = `
      <tr class="labels-row">
        <td class="sign-cell"></td>
        ${places.map(p => `<td class="place-label">${p}</td>`).join('')}
      </tr>
      <tr class="carry-row">
        <td class="sign-cell"></td>
        <td><input class="carry-box" maxlength="1" inputmode="numeric" data-idx="0"></td>
        <td><input class="carry-box" maxlength="1" inputmode="numeric" data-idx="1"></td>
        <td><input class="carry-box" maxlength="1" inputmode="numeric" data-idx="2" disabled></td>
      </tr>
      <tr class="operand-row">
        <td class="sign-cell"></td>
        ${da.map(d => `<td class="operand-digit">${d.trim()}</td>`).join('')}
      </tr>
      <tr class="operand-row">
        <td class="sign-cell">${opSym}</td>
        ${db.map(d => `<td class="operand-digit">${d.trim()}</td>`).join('')}
      </tr>
      <tr class="operand-row">
        <td class="sign-cell">${opSym}</td>
        ${dc.map(d => `<td class="operand-digit">${d.trim()}</td>`).join('')}
      </tr>
      <tr class="line-row"><td colspan="4"></td></tr>
      <tr class="answer-cells-row">
        <td class="sign-cell"></td>
        <td><input class="ans-box" maxlength="1" inputmode="numeric" data-idx="0"></td>
        <td><input class="ans-box" maxlength="1" inputmode="numeric" data-idx="1"></td>
        <td><input class="ans-box" maxlength="1" inputmode="numeric" data-idx="2"></td>
      </tr>
    `;

    ansBoxes = Array.from(colTable.querySelectorAll('.ans-box'));
    carryBoxes = Array.from(colTable.querySelectorAll('.carry-box'));

    [...ansBoxes, ...carryBoxes].forEach(box => {
      box.addEventListener('focus', () => { lastFocusedBox = box; });
      box.addEventListener('input', () => {
        box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
        if(box.value !== ''){ advanceFocus(box); }
      });
      box.addEventListener('keydown', e => {
        if(e.key === 'Backspace' && box.value === '' && box.classList.contains('ans-box')){
          const idx = ansBoxes.indexOf(box);
          if(idx < ansBoxes.length - 1){ ansBoxes[idx + 1].focus(); }
        }
      });
    });

    // Start where you'd start on paper: the ones column.
    ansBoxes[ansBoxes.length - 1].focus();
  }

  // After typing a digit, hop to the next column to the left (how you'd
  // work through the problem by hand), skipping any disabled carry box.
  function advanceFocus(box){
    if(box.classList.contains('ans-box')){
      const idx = ansBoxes.indexOf(box);
      if(idx > 0){ ansBoxes[idx - 1].focus(); }
    } else if(box.classList.contains('carry-box')){
      const idx = carryBoxes.indexOf(box);
      for(let i = idx - 1; i >= 0; i--){
        if(!carryBoxes[i].disabled){ carryBoxes[i].focus(); break; }
      }
    }
  }

  function nextQuestion(){
    locked = false;
    feedbackEl.textContent = '';
    feedbackEl.className = 'feedback';
    if(mode === 'round'){
      makeRoundingQuestion();
    } else {
      makeAddSubQuestion();
    }
  }

  // ---------- Rounding answer handling ----------
  function checkRoundingAnswer(selected, btnEl){
    if(locked) return;
    locked = true;
    const isCorrect = selected === current.correct;
    Array.from(choicesArea.children).forEach(b => {
      b.disabled = true;
      if(parseInt(b.textContent) === current.correct){ b.classList.add('correct'); }
    });
    if(!isCorrect){ btnEl.classList.add('wrong'); }
    registerResult(isCorrect);
  }

  // ---------- Add/Sub keypad ----------
  // Types into whichever column box was last focused, so a child using
  // taps instead of a physical keyboard still fills the grid column by column.
  function buildKeypad(){
    const keypad = document.getElementById('keypad');
    keypad.innerHTML = '';
    const keys = ['1','2','3','4','5','6','7','8','9','⌫','0','✔'];
    keys.forEach(k => {
      const btn = document.createElement('button');
      btn.className = k === '✔' ? 'key check-key' : 'key';
      btn.textContent = k;
      btn.onclick = () => pressKey(k);
      keypad.appendChild(btn);
    });
  }

  function pressKey(k){
    if(locked) return;
    if(k === '✔'){ submitAnswer(); return; }

    if(current.qType === 'missing'){
      if(k === '⌫'){
        missingValue = missingValue.slice(0, -1);
      } else if(missingValue.length < 4){
        missingValue += k;
      }
      missingInputEl.value = missingValue;
      return;
    }

    const box = lastFocusedBox || (ansBoxes.length ? ansBoxes[ansBoxes.length - 1] : null);
    if(!box) return;
    box.focus();
    if(k === '⌫'){
      box.value = '';
      if(box.classList.contains('ans-box')){
        const idx = ansBoxes.indexOf(box);
        if(idx < ansBoxes.length - 1){ ansBoxes[idx + 1].focus(); }
      }
    } else {
      box.value = k;
      advanceFocus(box);
    }
  }

  function submitAnswer(){
    if(locked) return;

    if(current.qType === 'missing'){
      if(missingValue === '') return;
      locked = true;
      submitBtn.disabled = true;
      const given = parseInt(missingValue, 10);
      const isCorrect = given === current.missingAnswer;
      if(isCorrect){
        missingInputEl.classList.add('correct');
      } else {
        missingInputEl.classList.add('wrong');
        missingInputEl.value = `${missingValue} → ${current.missingAnswer}`;
      }
      registerResult(isCorrect);
      return;
    }

    if(ansBoxes.length === 0) return;
    locked = true;
    submitBtn.disabled = true;
    const correctDigits = current.answer.toString().padStart(3, '0').split('');
    let allCorrect = true;
    ansBoxes.forEach((box, i) => {
      const given = box.value === '' ? '0' : box.value;
      if(given === correctDigits[i]){
        box.classList.add('correct');
      } else {
        allCorrect = false;
        box.classList.add('wrong');
        box.value = correctDigits[i]; // reveal the right digit in that column
      }
      box.disabled = true;
    });
    carryBoxes.forEach(b => { b.disabled = true; });
    registerResult(allCorrect);
  }

  // ---------- Shared result handling ----------
  function registerResult(isCorrect){
    if(isCorrect){
      score += 10;
      streak += 1;
      chest += 1;
      feedbackEl.textContent = pickPraise();
      feedbackEl.className = 'feedback good';
    } else {
      streak = 0;
      if(mode === 'round'){
        feedbackEl.textContent = `Close! ${current.num} rounds to ${current.correct}.`;
      } else if(current.qType === 'missing'){
        feedbackEl.textContent = `Not quite — the missing number was ${current.missingAnswer}.`;
      } else {
        feedbackEl.textContent = `Not quite — the answer was ${current.answer}.`;
      }
      feedbackEl.className = 'feedback bad';
    }
    updateStats();

    // Report every answer (right or wrong) to the backend so accuracy is
    // computed server-side - never trust the client for the reward-granting
    // calculation.
    if(currentAttemptId){
      api.post(`/api/game/attempts/${currentAttemptId}/answer`, { correct: isCorrect }).catch(() => {});
    }

    if(chest >= CHEST_GOAL){
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
      }catch(err){ /* fall through to celebration with no reward info */ }
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

    const stageCompleteText = mode === 'round'
      ? `Great rounding! Get ready for tougher numbers in Stage ${stage + 1}.`
      : `Great work! Stage ${stage + 1} brings 3-digit numbers and trickier challenges.`;

    if(lastCompletionResult && lastCompletionResult.rewardEarned){
      celebrateScreen.classList.add('reward-earned');
      emojiEl.textContent = '🏆💰✨';
      titleEl.textContent = 'Treasure Unlocked!';
      textEl.innerHTML = `<span class="reward-banner">You earned ${lastCompletionResult.minutesEarned} minutes of screen time! 🪙</span><br>Show a grown-up your treasure pouch.`;
    } else if(stage < MAX_STAGE){
      titleEl.textContent = 'Stage Complete!';
      textEl.textContent = stageCompleteText;
      if(lastCompletionResult && lastCompletionResult.passedThreshold === false){
        subtextEl.textContent = `So close! Try Stage ${stage} again to earn your treasure minutes.`;
        subtextEl.classList.remove('hidden');
      }
    } else {
      titleEl.textContent = 'Chest Filled!';
      textEl.textContent = `You reached ${score} points at the toughest stage — amazing work, explorer!`;
      if(lastCompletionResult && lastCompletionResult.passedThreshold === false){
        subtextEl.textContent = `So close! Try Stage ${stage} again to earn your treasure minutes.`;
        subtextEl.classList.remove('hidden');
      }
    }
    show('screen-celebrate');
  }

  async function nextRound(){
    if(stage < MAX_STAGE){ stage += 1; }
    chest = 0;
    updateStats();
    show('screen-game');
    try{
      await startAttempt(mode, stage);
    }catch(err){
      feedbackEl.textContent = "Couldn't start this stage - please try again.";
      feedbackEl.className = 'feedback bad';
      return;
    }
    nextQuestion();
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

    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => openStagePicker(btn.dataset.mode));
    });
    document.getElementById('backToModesBtn').addEventListener('click', goHome);
    document.getElementById('changeQuestBtn').addEventListener('click', goHome);
    document.getElementById('submitBtn').addEventListener('click', submitAnswer);
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
