const DEFAULT_HOME_TITLE = '我的收藏主页';
const STORAGE_KEY = 'bookmarkHomeConfig';
const AUTO_SCROLL_EDGE_SIZE = 120;
const AUTO_SCROLL_MAX_SPEED = 22;

const state = {
  allBookmarks: [],
  cards: [],
  config: {
    bookmarkMeta: {},
    cardAliases: {},
    cardOrder: [],
    editMode: false,
    homeTitle: DEFAULT_HOME_TITLE
  },
  editingBookmarkId: null,
  scrollAnimationFrameId: null,
  scrollSpeed: 0,
  isEditMode: false
};

const elements = {
  aliasInput: document.querySelector('#aliasInput'),
  bookmarkCount: document.querySelector('#bookmarkCount'),
  cancelEditButton: document.querySelector('#cancelEditButton'),
  cardsGrid: document.querySelector('#cardsGrid'),
  editDialog: document.querySelector('#editDialog'),
  editForm: document.querySelector('#editForm'),
  editOriginalTitle: document.querySelector('#editOriginalTitle'),
  emptyState: document.querySelector('#emptyState'),
  homeTitleInput: document.querySelector('#homeTitleInput'),
  modeLabel: document.querySelector('#modeLabel'),
  modeToggleButton: document.querySelector('#modeToggleButton'),
  resultCount: document.querySelector('#resultCount'),
  resultsList: document.querySelector('#resultsList'),
  resultsSection: document.querySelector('#resultsSection'),
  searchInput: document.querySelector('#searchInput'),
  rowTemplate: document.querySelector('#bookmarkRowTemplate'),
  tagsInput: document.querySelector('#tagsInput')
};

init();

async function init() {
  try {
    state.config = await loadConfig();
    state.isEditMode = Boolean(state.config.editMode);
    await reloadBookmarks();
    bindEvents();
    renderMode();
  } catch (error) {
    console.error(error);
    elements.bookmarkCount.textContent = '读取失败';
    showEmptyState(true);
  }
}

function bindEvents() {
  elements.searchInput.addEventListener('input', handleSearch);
  elements.modeToggleButton.addEventListener('click', toggleEditMode);
  elements.homeTitleInput.addEventListener('change', handleHomeTitleSave);
  elements.homeTitleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      elements.homeTitleInput.blur();
    }
  });
  elements.editForm.addEventListener('submit', handleBookmarkSave);
  elements.cancelEditButton.addEventListener('click', closeEditDialog);
  elements.editDialog.addEventListener('click', (event) => {
    if (event.target === elements.editDialog) {
      closeEditDialog();
    }
  });
  window.addEventListener('dragover', handleWindowDragOver);
  window.addEventListener('drop', stopAutoScroll);
  window.addEventListener('dragend', stopAutoScroll);
}

async function reloadBookmarks() {
  const tree = await getBookmarkTree();
  const roots = tree[0]?.children ?? [];

  state.cards = enrichCardSearchText(applyCardOrder(buildCards(roots)));
  state.allBookmarks = state.cards.flatMap((card) => card.bookmarks);

  updateCount();
  renderHomeTitle();

  if (elements.searchInput.value.trim()) {
    handleSearch({ target: elements.searchInput });
  } else {
    renderCards(state.cards);
  }
}

function getBookmarkTree() {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getTree((tree) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(tree);
    });
  });
}

function moveBookmark(bookmarkId, parentId) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.move(bookmarkId, { parentId }, (bookmark) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(bookmark);
    });
  });
}

function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      resolve({
        bookmarkMeta: {},
        cardAliases: {},
        cardOrder: [],
        editMode: false,
        homeTitle: DEFAULT_HOME_TITLE,
        ...(result[STORAGE_KEY] ?? {})
      });
    });
  });
}

function saveConfig() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: state.config }, () => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function buildCards(roots) {
  return roots
    .flatMap((root) => {
      const children = root.children ?? [];
      const looseBookmarks = children.filter(isBookmark).map((bookmark) => normalizeBookmark(bookmark, root.title));
      const folderCards = children.filter(isFolder).map((folder) => {
        const cardId = folder.id;
        const originalTitle = folder.title || '未命名文件夹';

        return {
          id: cardId,
          originalTitle,
          parentId: folder.id,
          title: getCardTitle(cardId, originalTitle),
          rootTitle: root.title || '收藏夹',
          bookmarks: collectBookmarks(folder, [root.title, folder.title].filter(Boolean))
        };
      });

      return [
        looseBookmarks.length > 0
          ? {
              id: `${root.id}-loose`,
              originalTitle: root.title || '收藏夹',
              parentId: root.id,
              title: getCardTitle(`${root.id}-loose`, root.title || '收藏夹'),
              rootTitle: '未分类收藏',
              bookmarks: looseBookmarks
            }
          : null,
        ...folderCards
      ].filter(Boolean);
    })
    .filter((card) => state.isEditMode || card.bookmarks.length > 0);
}

function collectBookmarks(node, path) {
  const children = node.children ?? [];

  return children.flatMap((child) => {
    if (isBookmark(child)) {
      return normalizeBookmark(child, path.join(' / '));
    }

    return collectBookmarks(child, [...path, child.title].filter(Boolean));
  });
}

function normalizeBookmark(bookmark, folderPath) {
  const url = bookmark.url ?? '';
  const title = bookmark.title?.trim() || getHost(url) || '未命名网页';
  const meta = state.config.bookmarkMeta[bookmark.id] ?? {};
  const tags = normalizeTags(meta.tags ?? []);
  const alias = typeof meta.alias === 'string' ? meta.alias.trim() : '';
  const displayTitle = alias || title;
  const host = getHost(url);

  return {
    id: bookmark.id,
    alias,
    displayTitle,
    folderPath,
    host,
    parentId: bookmark.parentId,
    tags,
    title,
    url,
    searchableText: `${displayTitle} ${title} ${url} ${host} ${folderPath} ${tags.join(' ')}`.toLowerCase()
  };
}

function applyCardOrder(cards) {
  const orderMap = new Map(state.config.cardOrder.map((cardId, index) => [cardId, index]));

  return [...cards].sort((first, second) => {
    const firstIndex = orderMap.has(first.id) ? orderMap.get(first.id) : Number.MAX_SAFE_INTEGER;
    const secondIndex = orderMap.has(second.id) ? orderMap.get(second.id) : Number.MAX_SAFE_INTEGER;

    return firstIndex - secondIndex;
  });
}

function enrichCardSearchText(cards) {
  return cards.map((card) => ({
    ...card,
    bookmarks: card.bookmarks.map((bookmark) => ({
      ...bookmark,
      searchableText: `${bookmark.searchableText} ${card.title} ${card.originalTitle} ${card.rootTitle}`.toLowerCase()
    }))
  }));
}

function renderCards(cards) {
  elements.cardsGrid.replaceChildren(...cards.map(createCard));
  showEmptyState(cards.length === 0);
}

function createCard(card) {
  const article = document.createElement('article');
  article.className = 'folder-card';
  article.draggable = state.isEditMode;
  article.dataset.cardId = card.id;
  article.dataset.parentId = card.parentId;
  article.addEventListener('dragstart', handleCardDragStart);
  article.addEventListener('dragover', handleCardDragOver);
  article.addEventListener('dragleave', handleCardDragLeave);
  article.addEventListener('drop', handleCardDrop);
  article.addEventListener('dragend', handleCardDragEnd);

  const header = document.createElement('header');
  header.className = 'folder-card-header';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'card-title-group';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'card-eyebrow';
  eyebrow.textContent = card.rootTitle;

  const titleInput = document.createElement('input');
  titleInput.className = 'card-title-input';
  titleInput.value = card.title;
  titleInput.readOnly = !state.isEditMode;
  titleInput.title = state.isEditMode ? `原文件夹名：${card.originalTitle}` : '切换到编辑模式后可修改名称';
  titleInput.addEventListener('change', () => handleCardRename(card.id, card.originalTitle, titleInput.value));
  titleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      titleInput.blur();
    }
  });
  titleInput.addEventListener('mousedown', (event) => event.stopPropagation());

  const hint = document.createElement('p');
  hint.className = 'card-hint edit-only';
  hint.textContent = '拖动卡片排序，也可把网页拖到其它卡片';

  titleGroup.append(eyebrow, titleInput, hint);

  const count = document.createElement('span');
  count.className = 'count-pill';
  count.textContent = `${card.bookmarks.length}`;

  header.append(titleGroup, count);

  const list = document.createElement('div');
  list.className = 'bookmark-list';

  if (card.bookmarks.length === 0) {
    const emptyHint = document.createElement('p');
    emptyHint.className = 'empty-card-hint';
    emptyHint.textContent = '可把收藏拖到这里';
    list.append(emptyHint);
  } else {
    list.append(...card.bookmarks.map(createBookmarkRow));
  }

  article.append(header, list);
  return article;
}

function createBookmarkRow(bookmark) {
  const row = elements.rowTemplate.content.firstElementChild.cloneNode(true);
  const link = row.querySelector('.bookmark-link');
  const favicon = row.querySelector('.favicon');
  const title = row.querySelector('.bookmark-title');
  const tags = row.querySelector('.bookmark-tags');
  const url = row.querySelector('.bookmark-url');
  const editButton = row.querySelector('.bookmark-edit-button');

  row.draggable = state.isEditMode;
  row.dataset.bookmarkId = bookmark.id;
  row.addEventListener('dragstart', handleBookmarkDragStart);
  row.addEventListener('dragend', handleBookmarkDragEnd);
  link.draggable = false;
  link.href = bookmark.url;
  link.title = `${bookmark.displayTitle}\n${bookmark.url}\n${bookmark.folderPath}`;
  favicon.src = getFaviconUrl(bookmark.url);
  favicon.addEventListener('error', () => {
    favicon.hidden = true;
  }, { once: true });
  title.textContent = bookmark.displayTitle;
  url.textContent = bookmark.host || bookmark.url;
  tags.replaceChildren(...bookmark.tags.map(createTagPill));

  if (bookmark.tags.length === 0) {
    tags.hidden = true;
    link.classList.add('has-no-tags');
  }

  editButton.hidden = !state.isEditMode;
  editButton.addEventListener('click', () => openEditDialog(bookmark.id));

  return row;
}

function createTagPill(tag) {
  const pill = document.createElement('span');
  pill.className = 'tag-pill';
  pill.textContent = tag;
  return pill;
}

function handleSearch(event) {
  const keyword = event.target.value.trim().toLowerCase();

  if (!keyword) {
    elements.resultsSection.hidden = true;
    elements.cardsGrid.hidden = false;
    showEmptyState(state.cards.length === 0);
    return;
  }

  const results = state.allBookmarks.filter((bookmark) => bookmark.searchableText.includes(keyword));
  renderSearchResults(results);
}

function renderSearchResults(results) {
  elements.cardsGrid.hidden = true;
  elements.resultsSection.hidden = results.length === 0;
  elements.resultCount.textContent = `${results.length} 个结果`;
  elements.resultsList.replaceChildren(...results.map(createSearchResult));
  showEmptyState(results.length === 0);
}

function createSearchResult(bookmark) {
  const item = document.createElement('article');
  item.className = 'result-item';

  const row = createBookmarkRow(bookmark);
  item.append(row);
  return item;
}

async function toggleEditMode() {
  state.isEditMode = !state.isEditMode;
  state.config.editMode = state.isEditMode;
  renderMode();
  await saveConfig();
  await reloadBookmarks();
}

function renderMode() {
  document.body.dataset.mode = state.isEditMode ? 'edit' : 'read';
  elements.modeToggleButton.setAttribute('aria-pressed', String(state.isEditMode));
  elements.modeLabel.textContent = state.isEditMode ? '编辑模式' : '只读模式';
  elements.modeToggleButton.title = state.isEditMode ? '点击切换到只读模式' : '点击切换到编辑模式';
  elements.homeTitleInput.readOnly = !state.isEditMode;
  elements.homeTitleInput.title = state.isEditMode ? '修改后按 Enter 或移开焦点保存' : '切换到编辑模式后可修改主页标题';
}

function renderHomeTitle() {
  elements.homeTitleInput.value = getHomeTitle();
}

async function handleHomeTitleSave() {
  const cleanTitle = elements.homeTitleInput.value.trim() || DEFAULT_HOME_TITLE;
  state.config.homeTitle = cleanTitle;
  elements.homeTitleInput.value = cleanTitle;
  await saveConfig();
}

async function handleCardRename(cardId, originalTitle, nextTitle) {
  if (!state.isEditMode) {
    refreshFromConfig();
    return;
  }

  const cleanTitle = nextTitle.trim();

  if (!cleanTitle || cleanTitle === originalTitle) {
    delete state.config.cardAliases[cardId];
  } else {
    state.config.cardAliases[cardId] = cleanTitle;
  }

  await saveConfig();
  refreshFromConfig();
}

function handleCardDragStart(event) {
  if (!state.isEditMode || event.target.closest('.bookmark-row, input, button')) {
    event.preventDefault();
    return;
  }

  event.currentTarget.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-card-id', event.currentTarget.dataset.cardId);
  startAutoScroll();
}

function handleCardDragOver(event) {
  if (!state.isEditMode) {
    return;
  }

  event.preventDefault();
  event.currentTarget.classList.add('is-drop-target');
}

function handleCardDragLeave(event) {
  event.currentTarget.classList.remove('is-drop-target');
}

async function handleCardDrop(event) {
  if (!state.isEditMode) {
    return;
  }

  event.preventDefault();
  event.currentTarget.classList.remove('is-drop-target');

  const bookmarkId = event.dataTransfer.getData('application/x-bookmark-id');
  const targetParentId = event.currentTarget.dataset.parentId;

  if (bookmarkId && targetParentId) {
    await moveBookmarkToCard(bookmarkId, targetParentId);
    return;
  }

  const sourceId = event.dataTransfer.getData('application/x-card-id');
  const targetId = event.currentTarget.dataset.cardId;

  if (!sourceId || sourceId === targetId) {
    return;
  }

  const nextOrder = state.cards.map((card) => card.id);
  const sourceIndex = nextOrder.indexOf(sourceId);
  const targetIndex = nextOrder.indexOf(targetId);

  if (sourceIndex === -1 || targetIndex === -1) {
    return;
  }

  const [movedCardId] = nextOrder.splice(sourceIndex, 1);
  const shouldInsertAfter = isAfterCardMidline(event, event.currentTarget);
  const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const insertIndex = shouldInsertAfter ? adjustedTargetIndex + 1 : adjustedTargetIndex;

  nextOrder.splice(insertIndex, 0, movedCardId);
  state.config.cardOrder = nextOrder;
  await saveConfig();
  refreshFromConfig();
}

function handleCardDragEnd() {
  stopAutoScroll();
  document.querySelectorAll('.folder-card').forEach((card) => {
    card.classList.remove('is-dragging', 'is-drop-target');
  });
}

function handleBookmarkDragStart(event) {
  if (!state.isEditMode) {
    event.preventDefault();
    return;
  }

  event.stopPropagation();
  event.currentTarget.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-bookmark-id', event.currentTarget.dataset.bookmarkId);
  startAutoScroll();
}

function handleBookmarkDragEnd(event) {
  stopAutoScroll();
  event.currentTarget.classList.remove('is-dragging');
}

function handleWindowDragOver(event) {
  if (!state.isEditMode) {
    return;
  }

  updateAutoScrollSpeed(event.clientY);
}

function startAutoScroll() {
  if (state.scrollAnimationFrameId !== null) {
    return;
  }

  const scroll = () => {
    if (state.scrollSpeed !== 0) {
      window.scrollBy({ top: state.scrollSpeed, left: 0, behavior: 'auto' });
    }

    state.scrollAnimationFrameId = requestAnimationFrame(scroll);
  };

  state.scrollAnimationFrameId = requestAnimationFrame(scroll);
}

function stopAutoScroll() {
  state.scrollSpeed = 0;

  if (state.scrollAnimationFrameId !== null) {
    cancelAnimationFrame(state.scrollAnimationFrameId);
    state.scrollAnimationFrameId = null;
  }
}

function updateAutoScrollSpeed(pointerY) {
  const viewportHeight = window.innerHeight;

  if (pointerY < AUTO_SCROLL_EDGE_SIZE) {
    const distance = AUTO_SCROLL_EDGE_SIZE - Math.max(pointerY, 0);
    state.scrollSpeed = -calculateAutoScrollSpeed(distance);
    return;
  }

  if (pointerY > viewportHeight - AUTO_SCROLL_EDGE_SIZE) {
    const distance = pointerY - (viewportHeight - AUTO_SCROLL_EDGE_SIZE);
    state.scrollSpeed = calculateAutoScrollSpeed(distance);
    return;
  }

  state.scrollSpeed = 0;
}

function calculateAutoScrollSpeed(distance) {
  const ratio = Math.min(distance / AUTO_SCROLL_EDGE_SIZE, 1);

  return Math.max(4, Math.round(ratio * AUTO_SCROLL_MAX_SPEED));
}

function isAfterCardMidline(event, cardElement) {
  const rect = cardElement.getBoundingClientRect();
  const isSingleColumn = window.getComputedStyle(elements.cardsGrid).gridTemplateColumns.split(' ').length === 1;

  if (isSingleColumn) {
    return event.clientY > rect.top + rect.height / 2;
  }

  return event.clientX > rect.left + rect.width / 2 || event.clientY > rect.top + rect.height * 0.72;
}

async function moveBookmarkToCard(bookmarkId, targetParentId) {
  const bookmark = state.allBookmarks.find((item) => item.id === bookmarkId);

  if (!bookmark || bookmark.parentId === targetParentId) {
    return;
  }

  await moveBookmark(bookmarkId, targetParentId);
  await reloadBookmarks();
}

function openEditDialog(bookmarkId) {
  if (!state.isEditMode) {
    return;
  }

  const bookmark = state.allBookmarks.find((item) => item.id === bookmarkId);

  if (!bookmark) {
    return;
  }

  state.editingBookmarkId = bookmarkId;
  elements.editOriginalTitle.textContent = bookmark.title;
  elements.aliasInput.value = bookmark.alias;
  elements.tagsInput.value = bookmark.tags.join(' ');
  elements.editDialog.hidden = false;
  elements.aliasInput.focus();
}

function closeEditDialog() {
  state.editingBookmarkId = null;
  elements.editDialog.hidden = true;
  elements.editForm.reset();
}

async function handleBookmarkSave(event) {
  event.preventDefault();

  if (!state.editingBookmarkId) {
    return;
  }

  const alias = elements.aliasInput.value.trim();
  const tags = normalizeTags(elements.tagsInput.value);

  if (!alias && tags.length === 0) {
    delete state.config.bookmarkMeta[state.editingBookmarkId];
  } else {
    state.config.bookmarkMeta[state.editingBookmarkId] = { alias, tags };
  }

  await saveConfig();
  closeEditDialog();
  refreshFromConfig();
}

function refreshFromConfig() {
  state.cards = enrichCardSearchText(applyCardOrder(state.cards.map((card) => ({
    ...card,
    title: getCardTitle(card.id, card.originalTitle),
    bookmarks: card.bookmarks.map((bookmark) => normalizeBookmark({
      id: bookmark.id,
      parentId: bookmark.parentId,
      title: bookmark.title,
      url: bookmark.url
    }, bookmark.folderPath))
  }))));
  state.allBookmarks = state.cards.flatMap((card) => card.bookmarks);
  renderHomeTitle();
  renderMode();

  if (elements.searchInput.value.trim()) {
    handleSearch({ target: elements.searchInput });
  } else {
    renderCards(state.cards);
  }
}

function getCardTitle(cardId, originalTitle) {
  return state.config.cardAliases[cardId]?.trim() || originalTitle;
}

function getHomeTitle() {
  return state.config.homeTitle?.trim() || DEFAULT_HOME_TITLE;
}

function normalizeTags(value) {
  const tags = Array.isArray(value) ? value : value.split(/[\s,，、]+/);

  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function updateCount() {
  elements.bookmarkCount.textContent = `${state.allBookmarks.length} 个收藏`;
}

function showEmptyState(isVisible) {
  elements.emptyState.hidden = !isVisible;
}

function isBookmark(node) {
  return typeof node.url === 'string';
}

function isFolder(node) {
  return !node.url && Array.isArray(node.children);
}

function getHost(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function getFaviconUrl(url) {
  return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
}
