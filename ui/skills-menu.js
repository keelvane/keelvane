const SKILLS_URL = '/api/skills';
const MAX_ITEMS = 8;

let cachedSkills = null;
let skillsPromise = null;

async function fetchSkills() {
  if (skillsPromise) return skillsPromise;
  skillsPromise = fetch(SKILLS_URL)
    .then((res) => res.json())
    .then((data) => {
      if (!data.ok) throw new Error(data.error || 'failed to load skills');
      cachedSkills = data.skills || [];
      return cachedSkills;
    })
    .catch((error) => {
      skillsPromise = null;
      cachedSkills = null;
      throw error;
    });
  return skillsPromise;
}

export function findSkill(name) {
  if (!cachedSkills) return null;
  const lower = name.toLowerCase();
  return cachedSkills.find((skill) => skill.name.toLowerCase() === lower) || null;
}

export function initSkillsMenu({ textarea, container }) {
  const menu = document.createElement('div');
  menu.className = 'skills-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  container.appendChild(menu);

  let activeIndex = -1;
  let items = [];
  let open = false;

  fetchSkills().catch(() => {});

  function close() {
    open = false;
    menu.hidden = true;
    activeIndex = -1;
    items = [];
    menu.textContent = '';
  }

  function queryFromCaret() {
    const value = textarea.value;
    const caret = textarea.selectionStart ?? value.length;
    if (!value.startsWith('/')) return null;
    const firstSpace = value.search(/\s/);
    const tokenEnd = firstSpace === -1 ? value.length : firstSpace;
    if (caret > tokenEnd) return null;
    const token = value.slice(0, caret);
    if (!/^\/[A-Za-z0-9._-]*$/.test(token)) return null;
    return token.slice(1);
  }

  function render(query, skills) {
    const q = query.toLowerCase();
    const starts = [];
    const contains = [];
    const desc = [];
    for (const skill of skills) {
      const name = skill.name.toLowerCase();
      if (name.startsWith(q)) starts.push(skill);
      else if (name.includes(q)) contains.push(skill);
      else if ((skill.description || '').toLowerCase().includes(q)) desc.push(skill);
    }
    items = [...starts, ...contains, ...desc].slice(0, MAX_ITEMS);
    menu.textContent = '';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'skills-empty';
      empty.textContent = 'No matching skills';
      menu.appendChild(empty);
      activeIndex = -1;
      return;
    }
    items.forEach((skill, index) => {
      const item = document.createElement('div');
      item.className = 'skill-item';
      item.setAttribute('role', 'option');
      item.dataset.index = String(index);

      const name = document.createElement('span');
      name.className = 'skill-name';
      name.textContent = '/' + skill.name;
      item.appendChild(name);

      const source = document.createElement('span');
      source.className = 'skill-source';
      source.textContent = skill.source;
      item.appendChild(source);

      const description = document.createElement('span');
      description.className = 'skill-desc';
      description.textContent = skill.description || '';
      item.appendChild(description);

      if (skill.unsupported) {
        const limited = document.createElement('span');
        limited.className = 'skill-limited';
        limited.textContent = 'limited';
        limited.title = skill.unsupported;
        item.appendChild(limited);
      }

      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(index);
      });
      item.addEventListener('mouseenter', () => setActive(index));
      menu.appendChild(item);
    });
    setActive(0);
  }

  function setActive(index) {
    if (index < 0 || index >= items.length) return;
    activeIndex = index;
    const children = menu.querySelectorAll('.skill-item');
    children.forEach((child, i) => {
      const active = i === index;
      child.classList.toggle('active', active);
      if (active) child.setAttribute('aria-selected', 'true');
      else child.removeAttribute('aria-selected');
    });
    children[index]?.scrollIntoView({ block: 'nearest' });
  }

  function pick(index) {
    if (index < 0 || index >= items.length) return;
    const skill = items[index];
    const value = textarea.value;
    const firstSpace = value.search(/\s/);
    const tokenEnd = firstSpace === -1 ? value.length : firstSpace;
    const replacement = '/' + skill.name + ' ';
    textarea.value = replacement + value.slice(tokenEnd);
    const caret = replacement.length;
    textarea.setSelectionRange(caret, caret);
    close();
    textarea.focus();
  }

  async function openMenu() {
    const query = queryFromCaret();
    if (query === null) {
      close();
      return;
    }
    try {
      const skills = await fetchSkills();
      // The text may have changed while the list loaded.
      const current = queryFromCaret();
      if (current === null) return close();
      open = true;
      menu.hidden = false;
      render(current, skills);
    } catch {
      open = true;
      menu.hidden = false;
      items = [];
      menu.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'skills-empty';
      empty.textContent = 'No matching skills';
      menu.appendChild(empty);
      activeIndex = -1;
    }
  }

  textarea.addEventListener('input', openMenu);
  textarea.addEventListener('click', openMenu);

  textarea.addEventListener('blur', () => {
    setTimeout(() => {
      if (!menu.contains(document.activeElement)) close();
    }, 120);
  });

  container.addEventListener('keydown', (e) => {
    if (!open || menu.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (items.length === 0) return;
      setActive((activeIndex + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (items.length === 0) return;
      setActive((activeIndex - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // No match: close and let Enter send the text as typed.
      if (items.length === 0) return close();
      e.preventDefault();
      e.stopPropagation();
      pick(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }, { capture: true });
}
