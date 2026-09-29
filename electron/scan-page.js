/* Runs inside a signed-in D2L page (isolated world). Collects the text of each
   course's announcements and the plain HTML pages in its Content, so
   deadlines.js can read them. Nothing is judged here.
   Expects a global OU_LIST (array of org unit ids) set before it runs. */
(async function () {
  const API = '/d2l/api/le/1.67/';
  const MAX_PAGES = 60;          // per course
  const MAX_BYTES = 300000;      // skip anything bigger (embedded media, exports)
  const MAX_TEXT = 40000;        // characters kept per page

  const get = (u) => fetch(u, { credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : ''), () => '');
  const text = (html) => {
    const d = new DOMParser().parseFromString(html || '', 'text/html');
    d.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
    // keep list items and table cells apart so dates don't glue onto the wrong line
    d.querySelectorAll('li,p,div,tr,td,th,br,h1,h2,h3,h4,h5,h6').forEach((n) => n.append(' \n '));
    return (d.body ? d.body.textContent : '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  };
  function walk(mods, out) {
    (mods || []).forEach((m) => {
      (m.Topics || []).forEach((t) => out.push(t));
      walk(m.Modules, out);
    });
    return out;
  }

  const ous = (typeof OU_LIST !== 'undefined' && OU_LIST) || [];
  const docs = [];
  const stats = { courses: 0, announcements: 0, pages: 0 };

  await Promise.all(ous.map(async (ou) => {
    stats.courses++;
    try {
      const arr = JSON.parse(await get(API + ou + '/news/') || '[]');
      for (const a of arr) {
        stats.announcements++;
        docs.push({ ou: String(ou), src: 'announcement', where: a.Title || 'Announcement',
                    url: '/d2l/lms/news/main.d2l?ou=' + ou, posted: a.StartDate || a.CreatedDate || null,
                    text: (a.Title || '') + '.\n' + text((a.Body && (a.Body.Html || a.Body.Text)) || '') });
      }
    } catch (e) { /* no announcements tool in this course */ }

    try {
      const toc = JSON.parse(await get(API + ou + '/content/toc') || '{}');
      const topics = walk(toc.Modules, []).filter((t) => t.Url && /^\/content\/.*\.html?$/i.test(t.Url.split('?')[0]) && !t.IsHidden);
      for (const t of topics.slice(0, MAX_PAGES)) {
        const html = await get(encodeURI(t.Url));
        if (!html || html.length > MAX_BYTES) continue;
        stats.pages++;
        // a page has no post date, so it's read from today
        docs.push({ ou: String(ou), src: 'page', where: t.Title || 'Course page',
                    url: '/d2l/le/content/' + ou + '/viewContent/' + t.TopicId + '/View', posted: null,
                    text: text(html).slice(0, MAX_TEXT) });
      }
    } catch (e) { /* content unavailable */ }
  }));

  return JSON.stringify({ docs, stats });
})();
