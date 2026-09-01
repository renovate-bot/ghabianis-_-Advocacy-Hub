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
	let savedEditorRange = null;

	function rememberEditorSelection(editor) {
		const selection = window.getSelection();
		if (selection && selection.rangeCount && editor.contains(selection.anchorNode)) {
			savedEditorRange = selection.getRangeAt(0).cloneRange();
		}
	}

	// Initialize when DOM ready
	document.addEventListener('DOMContentLoaded', () => {
		// Wire up elements
		const editor = $('notePaper');
		if (!editor) return;

		const toolbar = $('editorToolbar');
		if (toolbar) toolbar.addEventListener('mousedown', (e) => {
			rememberEditorSelection(editor);
		});
		document.addEventListener('selectionchange', () => {
			rememberEditorSelection(editor);
		});

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
			let serverNote = window.notes.find(n => n.id === id || String(n.id) === String(id));
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
		if (!editor) return;
		rememberEditorSelection(editor);
		editor.focus();
		try {
			if (savedEditorRange) {
				const selection = window.getSelection();
				selection.removeAllRanges();
				selection.addRange(savedEditorRange);
			}
			document.execCommand(cmd, false, value || null);
			savedEditorRange = null;
			updateCounts();
			scheduleAutosave();
		} catch (e) { console.warn('Formatting not supported', e); }
	}

	window.toggleList = function(command) {
		const editor = $('notePaper');
		if (!editor) return;
		const selection = window.getSelection();
		const range = (savedEditorRange || (selection.rangeCount ? selection.getRangeAt(0) : null))?.cloneRange();
		if (!range || !editor.contains(range.commonAncestorContainer)) {
			editor.focus();
			insertEmptyList(editor, command === 'insertOrderedList' ? 'ol' : 'ul');
			return;
		}
		editor.focus();
		const listType = command === 'insertOrderedList' ? 'ol' : 'ul';
		const text = range.toString() || '';
		if (!text.trim()) {
			convertCurrentLineToList(editor, range, listType);
		} else {
			range.deleteContents();
			const list = document.createElement(listType);
			text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).forEach(line => {
				const item = document.createElement('li');
				item.textContent = line;
				list.appendChild(item);
			});
			range.insertNode(list);
		}
		savedEditorRange = null;
		updateCounts();
		scheduleAutosave();
	}

	function convertCurrentLineToList(editor, range, listType) {
		const startNode = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer;
		const block = startNode?.closest('p, div, h1, h2, h3, h4, h5, h6, li');
		if (block && block !== editor && editor.contains(block)) {
			if (block.tagName === 'LI') {
				document.execCommand(listType === 'ol' ? 'insertOrderedList' : 'insertUnorderedList', false, null);
				return;
			}
			const list = document.createElement(listType);
			const item = document.createElement('li');
			item.innerHTML = block.innerHTML || '<br>';
			list.appendChild(item);
			block.replaceWith(list);
			placeCaretAtEnd(item);
			return;
		}

		const lines = (editor.innerText || editor.textContent || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
		if (!lines.length) {
			insertEmptyList(editor, listType);
			return;
		}
		editor.innerHTML = `<${listType}>${lines.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</${listType}>`;
		placeCaretAtEnd(editor.querySelector(`${listType} li:last-child`));
	}

	function placeCaretAtEnd(element) {
		if (!element) return;
		const caret = document.createRange();
		caret.selectNodeContents(element);
		caret.collapse(false);
		const selection = window.getSelection();
		selection.removeAllRanges();
		selection.addRange(caret);
	}

	function insertEmptyList(editor, listType) {
		const range = document.createRange();
		range.selectNodeContents(editor);
		range.collapse(false);
		insertEmptyListAtRange(range, listType, editor);
	}

	function insertEmptyListAtRange(range, listType, editor) {
		const list = document.createElement(listType);
		const item = document.createElement('li');
		item.innerHTML = '<br>';
		list.appendChild(item);
		range.deleteContents();
		range.insertNode(list);
		const caret = document.createRange();
		caret.selectNodeContents(item);
		caret.collapse(false);
		const selection = window.getSelection();
		selection.removeAllRanges();
		selection.addRange(caret);
		editor.focus();
	}

	window.insertTable = function() {
		const rows = Math.min(10, Math.max(1, Number(prompt('Number of rows', '3')) || 3));
		const columns = Math.min(8, Math.max(1, Number(prompt('Number of columns', '3')) || 3));
		const cells = Array.from({ length: rows }, () => `<tr>${'<td><br></td>'.repeat(columns)}</tr>`).join('');
		applyFormat('insertHTML', `<table class="note-table"><tbody>${cells}</tbody></table><p><br></p>`);
	}

	window.insertLink = function() {
		const url = prompt('Enter URL');
		if (url) applyFormat('createLink', url);
	}

	window.toggleNoteExportMenu = function(event) {
		event?.stopPropagation();
		$('noteExportOptions')?.classList.toggle('hidden');
	}

	document.addEventListener('click', (event) => {
		const menu = $('noteExportMenu');
		if (menu && !menu.contains(event.target)) $('noteExportOptions')?.classList.add('hidden');
	});

	window.exportNoteFile = async function(format) {
		$('noteExportOptions')?.classList.add('hidden');
		if (format === 'pdf') return window.exportInlineNotePDF();
		const title = $('noteTitle')?.value.trim() || 'Note';
		const editor = $('notePaper');
		if (!editor || !editor.innerText.trim()) return showToast('Nothing to export', 'info');
		if (!window.docx) return showToast('DOCX export library is unavailable', 'error');

		const { Document, Packer, Paragraph, TextRun, HeadingLevel, LevelFormat, Table, TableRow, TableCell, WidthType } = window.docx;
		const paragraphs = [];
		const addNode = (node, listLevel = 0, numbered = false) => {
			if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
				paragraphs.push(new Paragraph({ children: [new TextRun(node.textContent)] }));
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			const tag = node.tagName.toLowerCase();
			if (tag === 'table') {
				const rows = Array.from(node.children).flatMap(section => Array.from(section.children).filter(row => row.tagName.toLowerCase() === 'tr'));
				const tableRows = rows.map(row => new TableRow({ children: Array.from(row.children).filter(cell => ['td', 'th'].includes(cell.tagName.toLowerCase())).map(cell => new TableCell({ children: (cell.innerText || '').split(/\r?\n/).map(line => new Paragraph({ children: [new TextRun(line)] })), width: { size: 100, type: WidthType.AUTO } })) }));
			if (tableRows.length) paragraphs.push(new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
			return;
		}
			if (tag === 'ul' || tag === 'ol') {
				Array.from(node.children).filter(item => item.tagName.toLowerCase() === 'li').forEach(item => addNode(item, listLevel, tag === 'ol'));
				return;
			}
			if (tag === 'li') {
				const nestedLists = Array.from(node.children).filter(child => ['ul', 'ol'].includes(child.tagName.toLowerCase()));
				const itemText = Array.from(node.childNodes).filter(child => child.nodeType === Node.TEXT_NODE || !['UL', 'OL'].includes(child.tagName)).map(child => child.textContent).join('').trim();
				if (itemText) paragraphs.push(new Paragraph({ text: itemText, numbering: { reference: numbered ? 'note-numbering' : 'note-bullets', level: listLevel } }));
				nestedLists.forEach(list => addNode(list, listLevel + 1, list.tagName.toLowerCase() === 'ol'));
				return;
			}
			if (/^h[1-6]$/.test(tag)) {
				paragraphs.push(new Paragraph({ text: node.innerText.trim(), heading: tag === 'h1' ? HeadingLevel.HEADING_1 : tag === 'h2' ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3 }));
				return;
			}
			if (tag === 'br') return;
			if (node.children.length) Array.from(node.childNodes).forEach(child => addNode(child, listLevel, numbered));
			else if (node.innerText.trim()) paragraphs.push(new Paragraph({ text: node.innerText.trim() }));
		};
		Array.from(editor.childNodes).forEach(node => addNode(node));
		const documentFile = new Document({ numbering: { config: [{ reference: 'note-numbering', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: 'left' }, { level: 1, format: LevelFormat.DECIMAL, text: '%2.', alignment: 'left' }] }, { reference: 'note-bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: 'left' }, { level: 1, format: LevelFormat.BULLET, text: '\u2022', alignment: 'left' }] }] }, sections: [{ children: [new Paragraph({ text: title, heading: HeadingLevel.TITLE }), ...paragraphs] }] });
		const blob = await Packer.toBlob(documentFile);
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = `${title.replace(/[^a-z0-9_-]+/gi, '_') || 'note'}.docx`;
		link.click();
		URL.revokeObjectURL(link.href);
		showToast('DOCX exported', 'success');
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
		const title = $('noteTitle')?.value.trim() || 'Note';
		const exportRoot = document.createElement('div');
		exportRoot.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;padding:40px;background:#fff;color:#111;overflow:visible;';
		exportRoot.innerHTML = `<h1 style="font-size:24px;margin:0 0 24px;">${escapeHtml(title)}</h1><div style="font-size:16px;line-height:1.6;">${el.innerHTML}</div>`;
		document.body.appendChild(exportRoot);
		try {
			const canvas = await html2canvas(exportRoot, { scale: 2, useCORS: true, width: 880, windowWidth: 880, scrollX: 0, scrollY: 0 });
			const pdf = new jspdf.jsPDF('p', 'mm', 'a4');
			const pageWidth = pdf.internal.pageSize.getWidth();
			const pageHeight = pdf.internal.pageSize.getHeight();
			const margin = 10;
			const imgWidth = pageWidth - margin * 2;
			const pageCanvasHeight = Math.floor(canvas.width * ((pageHeight - margin * 2) / imgWidth));
			for (let offset = 0, page = 0; offset < canvas.height; offset += pageCanvasHeight, page++) {
				const pageCanvas = document.createElement('canvas');
				pageCanvas.width = canvas.width;
				pageCanvas.height = Math.min(pageCanvasHeight, canvas.height - offset);
				pageCanvas.getContext('2d').drawImage(canvas, 0, offset, canvas.width, pageCanvas.height, 0, 0, pageCanvas.width, pageCanvas.height);
				if (page > 0) pdf.addPage();
				const imgHeight = (pageCanvas.height * imgWidth) / pageCanvas.width;
				pdf.addImage(pageCanvas.toDataURL('image/png'), 'PNG', margin, margin, imgWidth, imgHeight);
			}
			pdf.save(`${title.replace(/[^a-z0-9_-]+/gi, '_') || 'note'}.pdf`);
		} catch (e) {
			console.error(e); showToast('Export failed', 'error');
		} finally { exportRoot.remove(); }
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
