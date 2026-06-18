// ==========================================================================
// IndexedDB Setup for Audio Recording Persistence
// ==========================================================================
const DB_NAME = 'EnglishMasteryDB';
const STORE_NAME = 'recordings';
let db = null;

async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = (e) => {
      console.error('IndexedDB failed to open:', e.target.error);
      reject(e.target.error);
    };
  });
}

async function saveRecording(id, day, blob, name) {
  if (!db) await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const item = {
      id,
      day,
      blob,
      name,
      timestamp: new Date().toLocaleString()
    };
    const request = store.put(item);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getRecordingsForDay(day) {
  if (!db) await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const all = request.result || [];
      const filtered = all.filter(item => item.day === day);
      resolve(filtered);
    };
    request.onerror = () => reject(request.error);
  });
}

async function deleteRecording(id) {
  if (!db) await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}


// ==========================================================================
// Application State
// ==========================================================================
let state = {
  completedDays: {},    // dayNum: boolean
  confidence: {},       // dayNum: number (1-5)
  homework: {},         // dayNum: string
  subtopicsChecked: {}, // dayNum: array of boolean indices
  completedDates: [],   // list of 'YYYY-MM-DD' strings
  streak: 0,
  activeFilterPhase: 'all',
  activeFilterWeek: 'all',
  activeFilterStatus: 'all',
  searchQuery: '',
  activeDay: null       // Day object currently open in modal
};

// ==========================================================================
// Audio Recorder Variables
// ==========================================================================
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let analyserNode = null;
let animationFrameId = null;
let recordStartTime = null;
let timerInterval = null;


// ==========================================================================
// Constants & Templates
// ==========================================================================
const grammarTemplate = [
  { time: "0:00 – 2:00", title: "Hook & Warm-up", desc: "Start with a common mistake sentence. Pose the question: 'What is wrong here?'" },
  { time: "2:00 – 22:00", title: "Core Lecture", desc: "Breakdown of each sub-topic rule with clear formulas and 1–2 practical examples." },
  { time: "22:00 – 27:00", title: "Interactive Practice Lab", desc: "Walk through 4–5 practice items step-by-step, explaining the correct reasoning." },
  { time: "27:00 – 30:00", title: "Recap & Preview", desc: "Summarize today's core point, deliver the bonus mastery tip, and preview tomorrow." }
];

const speakingTemplate = [
  { time: "0:00 – 2:00", title: "Sound Demonstration", desc: "Play or demonstrate the target sound, pattern, or key phrase clearly." },
  { time: "2:00 – 15:00", title: "Modeling & Mistakes Analysis", desc: "Deconstruct the production mechanics. Explain why language learners commonly miss it." },
  { time: "15:00 – 25:00", title: "Guided Repetition & Drills", desc: "Follow along: 'pause and repeat' prompts, mouth-shape guidance, or role-play lines." },
  { time: "25:00 – 30:00", title: "Context Integration & Wrap-up", desc: "Recap. Present one real-life situation to try out before the next lesson." }
];


// ==========================================================================
// Global Course Data References
// ==========================================================================
let activeCourseSyllabus = [];

async function loadCourseData() {
  try {
    const response = await fetch('course-data.json');
    if (response.ok) {
      activeCourseSyllabus = await response.json();
      console.log('Loaded course data from JSON file.');
    } else {
      throw new Error('Response code not OK');
    }
  } catch (err) {
    console.warn('CORS or network error loading course-data.json, falling back to course-data.js content:', err);
    if (typeof courseData !== 'undefined') {
      activeCourseSyllabus = courseData;
    } else {
      console.error('No fallback courseData found.');
    }
  }
}

// ==========================================================================
// Initializer & Setup
// ==========================================================================
document.addEventListener('DOMContentLoaded', async () => {
  await loadCourseData();
  loadStateFromLocalStorage();
  updateStreak();
  updateDashboardMetrics();
  renderDaysGrid();
  setupEventListeners();
  await initDB();
});


// ==========================================================================
// State Management Functions
// ==========================================================================
function loadStateFromLocalStorage() {
  state.completedDays = {};
  state.completedDates = [];
  state.subtopicsChecked = {};

  activeCourseSyllabus.forEach(day => {
    if (day.completed) {
      state.completedDays[day.day] = true;
      state.completedDates.push(new Date().toISOString().split('T')[0]);
      if (day.subtopics) {
        state.subtopicsChecked[day.day] = day.subtopics.map(() => true);
      }
    }
  });
}

function saveStateToLocalStorage() {
  // Public view is read-only, do not save to local storage
}

function updateStreak() {
  if (state.completedDates.length === 0) {
    state.streak = 0;
    document.getElementById('streakCount').textContent = '0';
    return;
  }

  // Sort dates descending
  const dates = [...new Set(state.completedDates)].sort((a, b) => new Date(b) - new Date(a));
  
  const todayStr = getLocalDateString(new Date());
  const yesterdayStr = getLocalDateString(new Date(Date.now() - 86400000));
  
  // If the latest completion date is not today or yesterday, streak is broken/0
  if (dates[0] !== todayStr && dates[0] !== yesterdayStr) {
    state.streak = 0;
    document.getElementById('streakCount').textContent = '0';
    saveStateToLocalStorage();
    return;
  }

  let currentStreak = 1;
  let prevDate = new Date(dates[0]);

  for (let i = 1; i < dates.length; i++) {
    const currDate = new Date(dates[i]);
    const diffTime = Math.abs(prevDate - currDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 1) {
      currentStreak++;
      prevDate = currDate;
    } else if (diffDays > 1) {
      // Gap in dates, stop counting
      break;
    }
  }

  state.streak = currentStreak;
  document.getElementById('streakCount').textContent = state.streak;
  saveStateToLocalStorage();
}

function getLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toggleDayComplete(dayNum) {
  const isCompleted = !state.completedDays[dayNum];
  state.completedDays[dayNum] = isCompleted;

  const todayStr = getLocalDateString(new Date());
  if (isCompleted) {
    // Add to completed dates
    if (!state.completedDates.includes(todayStr)) {
      state.completedDates.push(todayStr);
    }
    // Automatically check all subtopics if completing the whole day
    const dayObj = activeCourseSyllabus.find(d => d.day === dayNum);
    if (dayObj && dayObj.subtopics) {
      state.subtopicsChecked[dayNum] = dayObj.subtopics.map(() => true);
    }
  } else {
    // If uncompleting, check if we need to remove today's date from completed list
    // (Only if no other days were completed today)
    const otherCompletedToday = Object.keys(state.completedDays).some(
      key => key !== String(dayNum) && state.completedDays[key] === true
    );
    if (!otherCompletedToday) {
      state.completedDates = state.completedDates.filter(d => d !== todayStr);
    }
  }

  saveStateToLocalStorage();
  updateStreak();
  updateDashboardMetrics();
  renderDaysGrid();
  
  // Update modal complete button if modal is open
  if (state.activeDay && state.activeDay.day === dayNum) {
    updateModalCompleteButtonState();
    renderModalSubtopicsChecklist();
  }
}

function updateDashboardMetrics() {
  const totalDays = activeCourseSyllabus.length; // 50
  
  const completedList = Object.keys(state.completedDays).filter(k => state.completedDays[k] === true);
  const completedCount = completedList.length;
  
  // Percent calculations
  const overallPct = Math.round((completedCount / totalDays) * 100) || 0;
  
  const grammarDays = activeCourseSyllabus.filter(d => d.phase === 'grammar');
  const speakingDays = activeCourseSyllabus.filter(d => d.phase === 'speaking');
  
  const grammarCompleted = grammarDays.filter(d => state.completedDays[d.day]).length;
  const speakingCompleted = speakingDays.filter(d => state.completedDays[d.day]).length;
  
  const grammarPct = Math.round((grammarCompleted / grammarDays.length) * 100) || 0;
  const speakingPct = Math.round((speakingCompleted / speakingDays.length) * 100) || 0;

  // DOM Elements Updates
  document.getElementById('overallPercent').textContent = `${overallPct}%`;
  document.getElementById('overallFraction').textContent = `${completedCount} / ${totalDays} Days Completed`;
  document.getElementById('overallProgressBar').style.width = `${overallPct}%`;
  
  // Grammar Phase Rings
  document.getElementById('grammarPercent').textContent = `${grammarPct}%`;
  document.getElementById('grammarCountText').textContent = `${grammarCompleted} / ${grammarDays.length} Days`;
  setCircleDashoffset('grammarProgressRing', grammarPct);

  // Speaking Phase Rings
  document.getElementById('speakingPercent').textContent = `${speakingPct}%`;
  document.getElementById('speakingCountText').textContent = `${speakingCompleted} / ${speakingDays.length} Days`;
  setCircleDashoffset('speakingProgressRing', speakingPct);

  // Avg Confidence
  const confidenceKeys = Object.keys(state.confidence).filter(k => state.confidence[k] > 0);
  if (confidenceKeys.length > 0) {
    const totalConfidence = confidenceKeys.reduce((acc, key) => acc + state.confidence[key], 0);
    const avg = Math.round((totalConfidence / (confidenceKeys.length * 5)) * 100);
    document.getElementById('avgConfidence').textContent = `${avg}%`;
  } else {
    document.getElementById('avgConfidence').textContent = '0%';
  }
}

function setCircleDashoffset(elementId, percentage) {
  const circle = document.getElementById(elementId);
  if (!circle) return;
  const radius = circle.r.baseVal.value;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;
  circle.style.strokeDashoffset = offset;
}


// ==========================================================================
// Card Rendering & Filtering
// ==========================================================================
function renderDaysGrid() {
  const gridContainer = document.getElementById('cardsGrid');
  gridContainer.innerHTML = '';
  
  const filteredData = activeCourseSyllabus.filter(item => {
    // 1. Search Query Filter
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const matchTitle = item.title.toLowerCase().includes(q);
      const matchDay = `day ${item.day}`.includes(q);
      const matchTopics = item.subtopics.some(sub => sub.toLowerCase().includes(q));
      const matchHomework = item.homework && item.homework.some(hw => hw.toLowerCase().includes(q));
      
      if (!matchTitle && !matchDay && !matchTopics && !matchHomework) {
        return false;
      }
    }
    
    // 2. Phase Filter
    if (state.activeFilterPhase !== 'all' && item.phase !== state.activeFilterPhase) {
      return false;
    }
    
    // 3. Week Filter
    if (state.activeFilterWeek !== 'all' && item.week !== parseInt(state.activeFilterWeek)) {
      return false;
    }
    
    // 4. Status Filter
    const isCompleted = !!state.completedDays[item.day];
    const confidenceRating = state.confidence[item.day] || 0;
    const isNewTopic = !!item.isNew;
    
    if (state.activeFilterStatus === 'completed' && !isCompleted) return false;
    if (state.activeFilterStatus === 'incomplete' && isCompleted) return false;
    if (state.activeFilterStatus === 'new' && !isNewTopic) return false;
    if (state.activeFilterStatus === 'starred' && confidenceRating < 4) return false;
    if (state.activeFilterStatus === 'low-confidence' && (confidenceRating === 0 || confidenceRating > 2)) return false;
    
    return true;
  });

  document.getElementById('resultsCount').textContent = `${filteredData.length} days shown`;

  if (filteredData.length === 0) {
    gridContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <h3>No days match your filters</h3>
        <p>Try searching for a different topic, clearing the search box, or expanding your filters.</p>
      </div>
    `;
    return;
  }

  filteredData.forEach(item => {
    const isDone = !!state.completedDays[item.day];
    const rating = state.confidence[item.day] || 0;
    const notesLength = state.homework[item.day] ? state.homework[item.day].trim().length : 0;
    
    const card = document.createElement('div');
    card.className = `day-card ${isDone ? 'completed' : ''}`;
    card.setAttribute('data-day', item.day);
    
    // Render list of preview subtopics
    const subtopicPreviewHtml = item.subtopics.slice(0, 2).map(sub => `<li>${sub}</li>`).join('');
    
    // Confidence indicator rating representation
    const ratingHtml = rating > 0 
      ? `<span class="card-confidence" title="Confidence: ${rating}/5">⭐ ${rating}</span>`
      : '';
      
    const notebookBadgeHtml = notesLength > 0 
      ? `<span class="card-notebook-indicator" title="Homework notes written">📝</span>`
      : '';

    const playBtnHtml = item.videoLink 
      ? `<a href="${item.videoLink}" target="_blank" class="card-play-btn" title="Watch Lesson Video">▶</a>`
      : '';

    card.innerHTML = `
      <div class="card-header-row">
        <span class="card-meta">Day ${item.day} • Week ${item.week}</span>
        <div class="card-badges">
          ${item.isNew ? '<span class="new-tag">NEW</span>' : ''}
          <span class="phase-badge ${item.phase === 'grammar' ? 'badge-grammar' : 'badge-speaking'}">${item.phase}</span>
        </div>
      </div>
      <h4>${item.title}</h4>
      <ul class="subtopics-preview">
        ${subtopicPreviewHtml}
        ${item.subtopics.length > 2 ? `<li class="more-indicator">+${item.subtopics.length - 2} more...</li>` : ''}
      </ul>
      <div class="card-footer-row">
        <div class="card-metrics">
          ${ratingHtml}
          ${notebookBadgeHtml}
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          ${playBtnHtml}
          <div class="card-checkbox-wrapper" title="Toggle complete state">
            <div class="custom-checkbox"></div>
          </div>
        </div>
      </div>
    `;
    
    // Handle opening modal on click
    card.addEventListener('click', (e) => {
      // If user clicked the checkbox or checkbox wrapper, toggle completion instead of opening modal
      if (e.target.closest('.card-checkbox-wrapper')) {
        e.stopPropagation();
        toggleDayComplete(item.day);
        return;
      }
      openDetailModal(item);
    });
    
    gridContainer.appendChild(card);
  });
}


// ==========================================================================
// Modal Actions & Tabs Controls
// ==========================================================================
async function openDetailModal(dayObj) {
  state.activeDay = dayObj;
  
  // Populate Title & Metadata
  document.getElementById('modalTitle').textContent = `Day ${dayObj.day} — ${dayObj.title}`;
  document.getElementById('modalWeek').textContent = `WEEK ${dayObj.week}`;
  
  const phaseBadge = document.getElementById('modalPhaseBadge');
  phaseBadge.textContent = dayObj.phase.toUpperCase();
  phaseBadge.className = `phase-badge ${dayObj.phase === 'grammar' ? 'badge-grammar' : 'badge-speaking'}`;
  
  const newBadge = document.getElementById('modalNewBadge');
  newBadge.style.display = dayObj.isNew ? 'inline-flex' : 'none';

  // Toggle Modal Watch Link Visibility
  const watchLink = document.getElementById('modalWatchLink');
  if (dayObj.videoLink) {
    watchLink.href = dayObj.videoLink;
    watchLink.style.display = 'inline-flex';
  } else {
    watchLink.style.display = 'none';
  }

  // Toggle Day Complete Button
  updateModalCompleteButtonState();
  
  // Confidence Stars Setup
  updateModalStarsState(state.confidence[dayObj.day] || 0);

  // Tab Selection Initialization
  document.querySelectorAll('.modal-tabs .tab-link').forEach(link => {
    link.classList.remove('active');
  });
  document.querySelectorAll('.modal-body .tab-content').forEach(content => {
    content.classList.remove('active');
  });
  
  // Default to Syllabus Tab
  document.querySelector('.tab-link[data-tab="syllabus-tab"]').classList.add('active');
  document.getElementById('syllabus-tab').classList.add('active');

  // Speaking Lab Visibility Rules (Show audio tab label clearly, customize content)
  const speakingTabNav = document.getElementById('speakingTabNav');
  if (dayObj.phase === 'speaking') {
    speakingTabNav.style.display = 'block';
  } else {
    // Still allow audio notes for grammar days, or keep it optional/subtle
    speakingTabNav.style.display = 'block'; 
  }

  // Render Subtopics Checklist
  renderModalSubtopicsChecklist();
  
  // Render Video Timeline Outline
  renderModalVideoTimeline();
  
  // Render Homework Description & Load textarea content
  renderModalHomeworkInfo();

  // Load Saved Audio Recordings from DB
  await renderModalSavedRecordings();

  // Show Modal Overlay
  document.getElementById('detailModal').classList.add('active');
  document.body.style.overflow = 'hidden'; // Disable background scroll
}

function closeDetailModal() {
  // Stop ongoing recording if active
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecordingAction();
  }
  
  // Clean up waveform animation frame
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  state.activeDay = null;
  document.getElementById('detailModal').classList.remove('active');
  document.body.style.overflow = ''; // Re-enable background scroll
}

function updateModalCompleteButtonState() {
  const isDone = !!state.completedDays[state.activeDay.day];
  const btn = document.getElementById('modalCompleteBtn');
  const textSpan = btn.querySelector('.btn-text');
  const iconSpan = btn.querySelector('.btn-icon');
  
  if (isDone) {
    btn.classList.add('is-done');
    textSpan.textContent = 'Day Completed';
    iconSpan.textContent = '✓';
  } else {
    btn.classList.remove('is-done');
    textSpan.textContent = 'Mark Day Complete';
    iconSpan.textContent = '✓';
  }
}

function updateModalStarsState(rating) {
  const starBtns = document.querySelectorAll('#modalStars .star-btn');
  starBtns.forEach(btn => {
    const starVal = parseInt(btn.getAttribute('data-rating'));
    if (starVal <= rating) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function renderModalSubtopicsChecklist() {
  const list = document.getElementById('modalSubtopicsList');
  list.innerHTML = '';
  
  const dayNum = state.activeDay.day;
  const subtopics = state.activeDay.subtopics;
  
  // Initialize checked state array if empty
  if (!state.subtopicsChecked[dayNum]) {
    state.subtopicsChecked[dayNum] = subtopics.map(() => false);
  }

  subtopics.forEach((topic, idx) => {
    const isChecked = !!state.subtopicsChecked[dayNum][idx];
    const li = document.createElement('li');
    li.className = isChecked ? 'checked' : '';
    
    li.innerHTML = `
      <input type="checkbox" class="subtopic-cb" id="sub_cb_${idx}" ${isChecked ? 'checked' : ''}>
      <label class="subtopic-text" for="sub_cb_${idx}">${topic}</label>
    `;
    
    // Handle checklist checking change
    const checkbox = li.querySelector('.subtopic-cb');
    const toggleFunc = () => {
      const isNowChecked = !state.subtopicsChecked[dayNum][idx];
      state.subtopicsChecked[dayNum][idx] = isNowChecked;
      
      li.className = isNowChecked ? 'checked' : '';
      checkbox.checked = isNowChecked;
      
      // Auto complete day if all subtopics are checked
      const allDone = state.subtopicsChecked[dayNum].every(val => val === true);
      if (allDone && !state.completedDays[dayNum]) {
        toggleDayComplete(dayNum);
      } else if (!allDone && state.completedDays[dayNum]) {
        // Uncomplete day if at least one subtopic was unchecked
        toggleDayComplete(dayNum);
      } else {
        saveStateToLocalStorage();
      }
    };
    
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      toggleFunc();
    });
    li.addEventListener('click', (e) => {
      if (e.target !== checkbox && e.target.tagName !== 'LABEL') {
        toggleFunc();
      }
    });
    
    list.appendChild(li);
  });
}

function renderModalVideoTimeline() {
  const timelineContainer = document.getElementById('videoTimeline');
  timelineContainer.innerHTML = '';
  
  const isGrammar = state.activeDay.phase === 'grammar';
  const steps = isGrammar ? grammarTemplate : speakingTemplate;
  const titleText = isGrammar ? "Grammar Video Template Structure" : "Speaking Video Template Structure";
  
  document.getElementById('templateTitleText').textContent = titleText;

  steps.forEach((step, idx) => {
    const item = document.createElement('div');
    // Accent middle parts of video plan to break monotony
    const isAccent = idx === 1 || idx === 2;
    item.className = `timeline-item ${isAccent ? 'accent' : 'active'}`;
    
    item.innerHTML = `
      <div class="timeline-dot"></div>
      <div class="timeline-content">
        <div class="timeline-time">${step.time}</div>
        <div class="timeline-title">${step.title}</div>
        <div class="timeline-desc">${step.desc}</div>
      </div>
    `;
    timelineContainer.appendChild(item);
  });
}

function renderModalHomeworkInfo() {
  const descContainer = document.getElementById('modalHomeworkDescription');
  descContainer.innerHTML = '';
  
  const hws = state.activeDay.homework;
  const dayNum = state.activeDay.day;
  
  if (!hws || hws.length === 0) {
    descContainer.innerHTML = `<p>No homework specified for today's review lesson. Use this space to write a summary or capture quick notes.</p>`;
  } else {
    hws.forEach(hw => {
      const p = document.createElement('p');
      p.innerHTML = `<strong>Task:</strong> ${hw}`;
      descContainer.appendChild(p);
    });
  }

  // Load Notebook textarea input
  const textarea = document.getElementById('homeworkTextarea');
  textarea.value = state.homework[dayNum] || '';
  
  // Reset Save status indicator
  const saveStatus = document.getElementById('notebookSaveStatus');
  saveStatus.classList.remove('visible');
}

async function renderModalSavedRecordings() {
  const playlist = document.getElementById('recordingsPlaylist');
  playlist.innerHTML = '';
  
  const dayNum = state.activeDay.day;
  const recordings = await getRecordingsForDay(dayNum);
  
  if (recordings.length === 0) {
    playlist.innerHTML = `<p class="empty-playlist-text">No recordings saved for this day yet. Record one above to start practicing.</p>`;
    return;
  }

  recordings.forEach(track => {
    const item = document.createElement('div');
    item.className = 'audio-track-item';
    
    // Create Object URL for audio blob
    const audioUrl = URL.createObjectURL(track.blob);
    
    item.innerHTML = `
      <div class="track-info">
        <span class="track-name">${track.name}</span>
        <span class="track-time">${track.timestamp}</span>
      </div>
      <audio src="${audioUrl}" controls></audio>
      <button class="delete-track-btn" data-id="${track.id}" title="Delete attempt">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>
    `;
    
    // Handle deletion
    item.querySelector('.delete-track-btn').addEventListener('click', async (e) => {
      if (confirm('Delete this recording attempt?')) {
        await deleteRecording(track.id);
        renderModalSavedRecordings();
      }
    });
    
    playlist.appendChild(item);
  });
}


// ==========================================================================
// Voice Recorder Implementations
// ==========================================================================
async function startRecordingAction() {
  audioChunks = [];
  
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Setup Media Recorder
    mediaRecorder = new MediaRecorder(stream);
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
      const recordId = Date.now();
      const attemptNum = (await getRecordingsForDay(state.activeDay.day)).length + 1;
      const trackName = `Attempt #${attemptNum}`;
      
      await saveRecording(recordId, state.activeDay.day, audioBlob, trackName);
      
      // Stop all tracks in stream
      stream.getTracks().forEach(track => track.stop());
      
      // Reset indicator
      document.getElementById('recordingStatusText').textContent = 'Microphone Ready';
      document.getElementById('recordingIndicator').closest('.recorder-panel').classList.remove('recording');
      
      renderModalSavedRecordings();
    };

    // Begin Recording
    mediaRecorder.start();
    recordStartTime = Date.now();
    
    // Visual indicator states
    document.getElementById('recordingStatusText').textContent = 'Recording Voice...';
    document.getElementById('recordingIndicator').closest('.recorder-panel').classList.add('recording');
    document.getElementById('startRecordBtn').disabled = true;
    document.getElementById('stopRecordBtn').disabled = false;
    
    // Start Recorder Timer UI
    startRecordingTimerUI();

    // Init Web Audio visualizer waveform
    startWaveformVisualizer(stream);
    
  } catch (err) {
    console.error('Error opening microphone stream:', err);
    alert('Failed to access microphone. Please ensure microphone permissions are granted in your browser settings.');
  }
}

function stopRecordingAction() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  
  document.getElementById('startRecordBtn').disabled = false;
  document.getElementById('stopRecordBtn').disabled = true;
  
  clearInterval(timerInterval);
  timerInterval = null;
  
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function startRecordingTimerUI() {
  const timer = document.getElementById('recordingTimer');
  timer.textContent = '00:00';
  
  timerInterval = setInterval(() => {
    const elapsed = Date.now() - recordStartTime;
    const seconds = Math.floor((elapsed / 1000) % 60);
    const minutes = Math.floor((elapsed / 60000) % 60);
    timer.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }, 1000);
}

function startWaveformVisualizer(stream) {
  const canvas = document.getElementById('waveformCanvas');
  const canvasCtx = canvas.getContext('2d');
  
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(stream);
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 256;
  
  source.connect(analyserNode);
  
  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  
  const width = canvas.width;
  const height = canvas.height;
  
  function draw() {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') {
      // Clear visualizer to silent line
      canvasCtx.fillStyle = '#0a0816';
      canvasCtx.fillRect(0, 0, width, height);
      canvasCtx.lineWidth = 2;
      canvasCtx.strokeStyle = 'rgba(255,255,255,0.06)';
      canvasCtx.beginPath();
      canvasCtx.moveTo(0, height / 2);
      canvasCtx.lineTo(width, height / 2);
      canvasCtx.stroke();
      return;
    }
    
    animationFrameId = requestAnimationFrame(draw);
    analyserNode.getByteFrequencyData(dataArray);
    
    canvasCtx.fillStyle = '#0a0816';
    canvasCtx.fillRect(0, 0, width, height);
    
    const barWidth = (width / bufferLength) * 2.5;
    let barHeight;
    let x = 0;
    
    for (let i = 0; i < bufferLength; i++) {
      barHeight = dataArray[i] / 2;
      
      // Vibrant pink-to-violet visualizer bars
      const g = canvasCtx.createLinearGradient(0, height, 0, 0);
      g.addColorStop(0, '#8b5cf6');
      g.addColorStop(1, '#ec4899');
      
      canvasCtx.fillStyle = g;
      canvasCtx.fillRect(x, height - barHeight, barWidth - 2, barHeight);
      
      x += barWidth;
    }
  }
  
  draw();
}


// ==========================================================================
// Setup Listeners & DOM Connections
// ==========================================================================
function setupEventListeners() {
  // --- Header Data Reset ---
  document.getElementById('resetDataBtn').addEventListener('click', () => {
    if (confirm('Are you absolutely sure you want to reset all progress, ratings, and notebook notes? This cannot be undone.')) {
      localStorage.removeItem('english_mastery_state');
      state.completedDays = {};
      state.confidence = {};
      state.homework = {};
      state.subtopicsChecked = {};
      state.completedDates = [];
      state.streak = 0;
      
      // Clean IndexedDB recordings as well
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      transaction.objectStore(STORE_NAME).clear();
      
      updateStreak();
      updateDashboardMetrics();
      renderDaysGrid();
      
      if (state.activeDay) {
        closeDetailModal();
      }
    }
  });

  // --- Filtering & Search Controls ---
  const searchInput = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearSearchBtn');
  
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    clearBtn.style.display = state.searchQuery ? 'block' : 'none';
    renderDaysGrid();
  });
  
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    clearBtn.style.display = 'none';
    renderDaysGrid();
  });

  // Phase Tab Filter Button Listeners
  document.querySelectorAll('#phaseFilter .tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#phaseFilter .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeFilterPhase = btn.getAttribute('data-filter');
      renderDaysGrid();
    });
  });

  // Select Dropdowns Change listeners
  document.getElementById('weekSelect').addEventListener('change', (e) => {
    state.activeFilterWeek = e.target.value;
    renderDaysGrid();
  });

  document.getElementById('statusSelect').addEventListener('change', (e) => {
    state.activeFilterStatus = e.target.value;
    renderDaysGrid();
  });

  // --- Modal Specific Interaction Listeners ---
  document.getElementById('closeModalBtn').addEventListener('click', closeDetailModal);
  document.getElementById('detailModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('detailModal')) {
      closeDetailModal();
    }
  });

  // Modal Complete / Uncomplete Toggle button
  document.getElementById('modalCompleteBtn').addEventListener('click', () => {
    toggleDayComplete(state.activeDay.day);
  });

  // Modal Rating Picker Stars Hover/Click Handlers
  document.querySelectorAll('#modalStars .star-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseInt(btn.getAttribute('data-rating'));
      state.confidence[state.activeDay.day] = val;
      saveStateToLocalStorage();
      updateModalStarsState(val);
      updateDashboardMetrics();
      renderDaysGrid();
    });
  });

  // Modal Inner Tabs Switching Logic
  document.querySelectorAll('.modal-tabs .tab-link').forEach(link => {
    link.addEventListener('click', () => {
      document.querySelectorAll('.modal-tabs .tab-link').forEach(l => l.classList.remove('active'));
      document.querySelectorAll('.modal-body .tab-content').forEach(c => c.classList.remove('active'));
      
      link.classList.add('active');
      const tabId = link.getAttribute('data-tab');
      document.getElementById(tabId).classList.add('active');
    });
  });

  // Notebook text editor auto-save on input
  const textarea = document.getElementById('homeworkTextarea');
  const saveStatus = document.getElementById('notebookSaveStatus');
  
  let typingTimer = null;
  textarea.addEventListener('input', () => {
    saveStatus.classList.remove('visible');
    
    // Auto save note after 1 second of pause in typing
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      saveHomeworkNotes();
    }, 800);
  });

  // Notebook click save button
  document.getElementById('saveHomeworkBtn').addEventListener('click', saveHomeworkNotes);

  function saveHomeworkNotes() {
    if (!state.activeDay) return;
    state.homework[state.activeDay.day] = textarea.value;
    saveStateToLocalStorage();
    renderDaysGrid(); // Update card stats representation indicators
    
    saveStatus.classList.add('visible');
  }

  // --- Recorder Panel button listeners ---
  document.getElementById('startRecordBtn').addEventListener('click', startRecordingAction);
  document.getElementById('stopRecordBtn').addEventListener('click', stopRecordingAction);

  // Original Markdown file viewer link simulation/alert
  document.getElementById('viewSyllabusPdf').addEventListener('click', (e) => {
    e.preventDefault();
    alert('The original complete markdown details are stored in your workspace directory file "50-Day-English-Course-Video-Plan.md".');
  });
}
