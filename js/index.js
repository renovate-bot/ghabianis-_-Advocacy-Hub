// Notes editor functionality: simple rich-text editor with autosave, export, and focus mode
(() => {
	const LS_NOTES_KEY = 'adv_notes_v1';
	const LS_DRAFT_KEY = 'adv_notes_draft_v1';

	// Helpers
	const $ = (id) => document.getElementById(id);
	const nowISO = () => new Date().toISOString();

	// Basic state (local drafts storage)
	let localNotes = [];
	let currentNoteId = null;
	let autosaveTimer = null;

	// Initialize when DOM ready
	document.addEventListener('DOMContentLoaded', () => {
		// Wire up elements
		const editor = $('notePaper');
		if (!editor) return;

		// Load local notes
		loadLocalNotes();
		renderLocalNotes();

		// Load draft if exists
		const draft = localStorage.getItem(LS_DRAFT_KEY);
		if (draft) {
			// don't auto-open, keep draft available when user opens editor
			console.info('Draft available');
		}

		// Input handling
		editor.addEventListener('input', () => {
			updateCounts();
			scheduleAutosave();
		});

		// Keyboard shortcuts (simple)
		editor.addEventListener('keydown', (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
				e.preventDefault();
				saveNote();
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
				e.preventDefault();
				applyFormat('bold');
			}
		});

		// Wire search input
		const search = $('noteSearch');
		if (search) search.addEventListener('input', renderLocalNotes);

		// New note button focus -> use inline editor wrapper
		const newBtn = $('newNoteBtn');
		if (newBtn) newBtn.addEventListener('click', () => window.openInlineEditor());

		updateCounts();
	});

	// Note storage (local)
	function loadLocalNotes() {
		try {
			localNotes = JSON.parse(localStorage.getItem(LS_NOTES_KEY) || '[]');
		} catch (e) { localNotes = []; }
	}

	function saveNotesArray() {
		localStorage.setItem(LS_NOTES_KEY, JSON.stringify(localNotes));
		$('statNotes') && ($('statNotes').textContent = String(localNotes.length));
	}

	// Render notes list: prefer server-backed notes when available, otherwise show local drafts
	function renderLocalNotes() {
		const list = $('notesList');
		if (!list) return;
		const q = ($('noteSearch') && $('noteSearch').value || '').toLowerCase().trim();
		list.innerHTML = '';

		// If server-side notes are loaded into global `notes`, prefer rendering them using the app's renderer
		if (window.notes && Array.isArray(window.notes) && window.notes.length > 0 && typeof window.renderNotes === 'function') {
			try {
				// let the global renderer handle the UI
				return window.renderNotes();
			} catch (e) {
				console.warn('Global renderNotes failed, falling back to local render', e);
			}
		}

		// Fallback: render local drafts from localStorage
		loadLocalNotes();
		const filtered = localNotes.filter(n => (n.title || '') + ' ' + (stripHtml(n.content) || '')
			&& ((n.title||'').toLowerCase().includes(q) || (stripHtml(n.content)||'').toLowerCase().includes(q)));
		if (filtered.length === 0) {
			list.innerHTML = '<div class="col-span-full text-center py-10 text-gray-300 text-sm">No notes yet. Create your first note!</div>';
			return;
		}
		filtered.reverse().forEach(note => {
			const card = document.createElement('div');
			card.className = 'bg-white rounded-xl p-4 shadow-sm border border-gray-100 cursor-pointer hover:shadow-md';
			card.innerHTML = `<div class="text-sm font-semibold text-gray-800 mb-2">${escapeHtml(note.title || 'Untitled')}</div><div class="text-sm text-gray-500" style="max-height:3.6em;overflow:hidden">${notePreview(note.content)}</div><div class="text-xs text-gray-400 mt-3">${new Date(note.updatedAt||note.createdAt).toLocaleString()}</div>`;
			card.addEventListener('click', () => openNoteForEdit(note.id));
			list.appendChild(card);
		});
	}

	function notePreview(html) {
		const text = stripHtml(html || '');
		return escapeHtml(text.length > 200 ? text.slice(0, 200) + '…' : text);
	}

	function stripHtml(html) { return (html || '').replace(/<[^>]+>/g, ''); }
	function escapeHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

	function openInlineEditorNew() {
		currentNoteId = null;
		$('noteTitle').value = '';
		$('notePaper').innerHTML = localStorage.getItem(LS_DRAFT_KEY) || '';
		$('noteEditor').classList.remove('hidden');
		$('notePaper').focus();
		updateCounts();
	}

	// Public wrapper: open inline editor for new or for existing id/object
	window.openInlineEditor = function (data) {
		console.log('openInlineEditor called with', data);
		if (!data) return openInlineEditorNew();
		const id = (typeof data === 'string') ? data : (data.id || null);
		console.log('openInlineEditor resolved id', id);
		if (id) return openNoteForEdit(id);
		return openInlineEditorNew();
	};

	function closeEditor() {
		$('noteEditor').classList.add('hidden');
		exitFocusMode();
	}
	window.closeEditor = closeEditor;

	async function openNoteForEdit(id) {
		console.log('openNoteForEdit called for', id);
		loadLocalNotes();
		let note = localNotes.find(n => n.id === id);
		// If not found in local storage, try server-loaded global `notes` array (supabase-backed)
		if (!note && window.notes && Array.isArray(window.notes)) {
			console.log('openNoteForEdit: server notes ids=', window.notes.map(n=>n.id));
			const serverNote = window.notes.find(n => n.id === id || String(n.id) === String(id));
			if (!serverNote) {
				// try looser matching (some codepaths may give partial ids)
				const partial = window.notes.find(n => String(n.id).includes(String(id)) || String(id).includes(String(n.id)));
				if (partial) {
					console.log('openNoteForEdit: found by partial match', partial.id);
				}
				// prefer exact if found
				if (partial && partial.id) serverNote = partial;
			}
			if (serverNote) {
				// Map server note to local note shape so editor can work
				note = { id: serverNote.id, title: serverNote.title, content: serverNote.content || serverNote.body || '' };
			}
		}
		// If still not found, attempt to fetch the note directly from Supabase by id
		if (!note && typeof supabaseClient !== 'undefined' && ((typeof currentUser !== 'undefined' && currentUser) || (typeof window !== 'undefined' && window.currentUser))) {
			try {
				console.log('openNoteForEdit: fetching note from server', id);
				const { data: fetched, error } = await supabaseClient.from('notes').select('*').eq('id', id).maybeSingle();
				if (!error && fetched) {
					// map possible fields
					note = { id: fetched.id, title: fetched.title || fetched.name || '', content: fetched.content || fetched.description || fetched.body || '' };
					// merge into local notes for quicker access next time
					loadLocalNotes();
					const idx = localNotes.findIndex(n => n.id === note.id);
					if (idx === -1) { localNotes.push({ id: note.id, title: note.title, content: note.content, createdAt: fetched.created_at, updatedAt: fetched.updated_at }); saveNotesArray(); }
				} else {
					console.warn('openNoteForEdit: server fetch failed', error);
				}
			} catch (e) {
				console.warn('openNoteForEdit: error fetching from server', e);
			}
		}
		console.log('openNoteForEdit found note?', !!note);
		if (!note) {
			// fallback: open modal so user can still edit
			try { showToast('Note not found locally — opening modal fallback', 'info'); } catch(e){}
			const editIdEl = document.getElementById('noteEditId');
			const titleEl = document.getElementById('noteTitle');
			const contentEl = document.getElementById('noteContent');
			if (editIdEl) editIdEl.value = id;
			if (titleEl) titleEl.value = '';
			if (contentEl) contentEl.value = '';
			document.getElementById('noteModal')?.classList.remove('hidden');
			return;
		}
		currentNoteId = id;
		$('noteTitle').value = note.title || '';
		$('notePaper').innerHTML = note.content || '';
		$('noteEditor').classList.remove('hidden');
		$('notePaper').focus();
		updateCounts();
	}

	window.saveInlineNote = saveNote;
	function saveNote() {
		const title = $('noteTitle').value.trim() || 'Untitled';
		const content = $('notePaper').innerHTML;
		const at = nowISO();
		loadLocalNotes();
		if (currentNoteId) {
			const note = localNotes.find(n => n.id === currentNoteId);
			if (note) { note.title = title; note.content = content; note.updatedAt = at; }
		} else {
			const id = 'n_' + Date.now();
			localNotes.push({ id, title, content, createdAt: at, updatedAt: at });
			currentNoteId = id;
		}
		saveNotesArray();
		localStorage.removeItem(LS_DRAFT_KEY);
		$('lastSaved').textContent = new Date().toLocaleString();
		renderLocalNotes();
		showToast('Saved (local)');

		// Also persist to Supabase via the app's global server saveNote() when available.
		// Populate the modal fields expected by the global `saveNote` implementation and call it.
		(async () => {
			try {
				if (typeof window.saveNote === 'function') {
					// set modal fields so global saveNote() can use them
					const editIdEl = document.getElementById('noteEditId');
					const titleEl = document.getElementById('noteTitle');
					const contentEl = document.getElementById('noteContent');
					const tagsEl = document.getElementById('noteTags');
					if (editIdEl) editIdEl.value = (currentNoteId && !String(currentNoteId).startsWith('n_')) ? currentNoteId : '';
					if (titleEl) titleEl.value = title;
					if (contentEl) contentEl.value = content;
					if (tagsEl) tagsEl.value = '';
					await window.saveNote(); // calls server save and reloads server notes
					showToast('Saved (server)', 'success');
				}
			} catch (err) {
				console.warn('Could not persist inline note via global saveNote():', err);
			}
		})();
	}

	function clearNote() {
		if (!confirm('Clear editor content?')) return;
		$('noteTitle').value = '';
		$('notePaper').innerHTML = '';
		updateCounts();
	}
	window.clearNote = clearNote;

	function scheduleAutosave() {
		if (autosaveTimer) clearTimeout(autosaveTimer);
		autosaveTimer = setTimeout(() => {
			localStorage.setItem(LS_DRAFT_KEY, $('notePaper').innerHTML);
			$('lastSaved').textContent = 'Draft saved';
		}, 900);
	}

	function updateCounts() {
		const text = stripHtml($('notePaper').innerHTML || '');
		const words = text.trim() ? text.trim().split(/\s+/).length : 0;
		$('wordCount').textContent = words;
		$('charCount').textContent = text.length;
	}

	// Simple formatting helper using execCommand for broad support
	window.applyFormat = function(cmd, value) {
		const editor = $('notePaper');
		editor.focus();
		try {
			document.execCommand(cmd, false, value || null);
			updateCounts();
			scheduleAutosave();
		} catch (e) { console.warn('Formatting not supported', e); }
	}

	window.insertLink = function() {
		const url = prompt('Enter URL');
		if (url) applyFormat('createLink', url);
	}

	// Focus mode toggles a fullscreen focused editor UI
	function enterFocusMode() {
		document.body.classList.add('notes-focus-mode');
		const editor = $('notePaper');
		if (editor) editor.style.maxHeight = '100vh';
	}

	function exitFocusMode() {
		document.body.classList.remove('notes-focus-mode');
		const editor = $('notePaper');
		if (editor) editor.style.maxHeight = '70vh';
	}

	window.toggleInlineFocusMode = function() {
		if (document.body.classList.contains('notes-focus-mode')) exitFocusMode(); else enterFocusMode();
	}

	// Export to PDF using html2canvas + jsPDF (both are included in index.html)
	window.exportInlineNotePDF = async function() {
		const el = $('notePaper');
		if (!el) return;
		showToast('Preparing PDF...');
		try {
			const canvas = await html2canvas(el, { scale: 2, useCORS: true });
			const imgData = canvas.toDataURL('image/png');
			const pdf = new jspdf.jsPDF('p', 'mm', 'a4');
			const pageWidth = pdf.internal.pageSize.getWidth();
			const pageHeight = pdf.internal.pageSize.getHeight();
			const imgProps = pdf.getImageProperties(imgData);
			const imgWidth = pageWidth - 20;
			const imgHeight = (imgProps.height * imgWidth) / imgProps.width;
			pdf.addImage(imgData, 'PNG', 10, 10, imgWidth, imgHeight);
			pdf.save((($('noteTitle').value||'note') + '.pdf').replace(/\s+/g,'_'));
		} catch (e) {
			console.error(e); showToast('Export failed', 'error');
		}
	}

	// Utility toast
	function showToast(text, type = 'success') {
		const t = $('toast');
		if (!t) return;
		t.textContent = text;
		t.className = `toast show ${type}`;
		setTimeout(() => t.className = 'toast', 1800);
	}

	// open note by id helper for external calls
	window.openNoteForEdit = openNoteForEdit;

})();
