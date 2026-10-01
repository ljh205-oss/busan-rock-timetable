// 그룹별 "볼 공연" 공유 API — Vercel 함수 + Upstash Redis (설치할 패키지 없음)
const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const PICK_RE = /^(fri|sat|sun)-(samrock|green|river|wave|hidden)-\d{4}$/;
const ID_RE = /^[a-z0-9]{12,40}$/;
const MAX_MEMBERS = 200;
const KEEP_SECONDS = 60 * 60 * 24 * 45; // 45일 뒤 자동 삭제

async function redis(command) {
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || 'status ' + r.status);
  return j.result;
}

function cleanGroup(g) {
  g = String(g || '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!g || g.length > 24 || /[\u0000-\u001f<>]/.test(g)) return null;
  return g;
}
function cleanName(n) {
  n = String(n || '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!n || n.length > 16 || /[\u0000-\u001f<>]/.test(n)) return null;
  return n;
}

// 요청한 본인은 빼고, 아이디도 숨긴 채 멤버 목록을 돌려줌
async function others(key, me) {
  const flat = (await redis(['HGETALL', key])) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] === me) continue;
    try {
      const v = JSON.parse(flat[i + 1]);
      out.push({ name: v.name, picks: (v.picks || []).filter(p => PICK_RE.test(p)), at: v.at || 0 });
    } catch (_) {}
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!DB_URL || !DB_TOKEN) {
    return res.status(500).json({ error: '저장소가 연결되지 않았습니다. Vercel 프로젝트의 Storage에서 Redis를 연결해 주세요.' });
  }
  try {
    if (req.method === 'GET') {
      const g = cleanGroup(req.query.g);
      if (!g) return res.status(400).json({ error: '그룹 코드가 올바르지 않습니다.' });
      return res.status(200).json({ members: await others('brf26:g:' + g, String(req.query.me || '')) });
    }

    if (req.method === 'POST') {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
      b = b || {};
      const g = cleanGroup(b.g);
      const id = String(b.id || '');
      if (!g || !ID_RE.test(id)) return res.status(400).json({ error: '그룹 코드를 확인해 주세요.' });
      const key = 'brf26:g:' + g;

      if (b.leave === true) {
        await redis(['HDEL', key, id]);
        return res.status(200).json({ members: [] });
      }

      const name = cleanName(b.name);
      if (!name) return res.status(400).json({ error: '이름은 1~16자로 입력해 주세요.' });
      const picks = Array.isArray(b.picks)
        ? [...new Set(b.picks.filter(p => typeof p === 'string' && PICK_RE.test(p)))].slice(0, 120)
        : [];

      const exists = await redis(['HEXISTS', key, id]);
      if (!exists) {
        const n = await redis(['HLEN', key]);
        if (n >= MAX_MEMBERS) return res.status(429).json({ error: '이 그룹은 인원이 가득 찼습니다.' });
      }
      await redis(['HSET', key, id, JSON.stringify({ name, picks, at: Date.now() })]);
      await redis(['EXPIRE', key, KEEP_SECONDS]);
      return res.status(200).json({ members: await others(key, id) });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: '허용되지 않는 요청입니다.' });
  } catch (e) {
    return res.status(502).json({ error: '저장소 응답 오류: ' + e.message });
  }
};
