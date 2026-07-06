const jwt = require('jsonwebtoken');
const config = require('./config');
const { logger } = require('./logger');

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    // Для cross-origin iframe нужен SameSite=None (только по HTTPS). Локально
    // по http держим Lax, иначе браузер отбрасывает куку.
    sameSite: config.cookieSecure ? 'none' : 'lax',
    domain: config.cookieDomain || undefined,
    maxAge: 7 * 24 * 3600 * 1000,
    path: '/',
  };
}

// Приём одноразового SSO-токена от таск-менеджера: проверяем общим секретом,
// затем ставим собственную сессионную куку бота (живёт своей жизнью).
function handleSsoAccept(req, res) {
  try {
    if (!config.ssoSecret || !config.sessionSecret) {
      return res.status(500).json({ error: 'SSO не сконфигурирован на боте' });
    }
    const token = req.body && req.body.token;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token обязателен' });
    }

    const payload = jwt.verify(token, config.ssoSecret, {
      audience: config.ssoAudience,
      issuer: config.ssoIssuer,
    });

    if (!payload.sub) {
      return res.status(400).json({ error: 'В SSO-токене нет sub' });
    }

    const roles = Array.isArray(payload.roles) ? payload.roles.map(norm) : [];
    if (!roles.includes('buyer') && !roles.includes('admin')) {
      return res.status(403).json({ error: 'Доступ только для баеров' });
    }

    const sessionToken = jwt.sign(
      {
        userId: String(payload.sub),
        email: payload.email || '',
        roles,
        buyerCode: payload.buyer_code || '',
      },
      config.sessionSecret,
      { expiresIn: '7d' },
    );

    res.cookie('auth_token', sessionToken, sessionCookieOptions());
    return res.json({
      ok: true,
      user: {
        id: String(payload.sub),
        email: payload.email || '',
        roles,
        buyerCode: payload.buyer_code || '',
      },
    });
  } catch (err) {
    const msg = err && err.name === 'TokenExpiredError'
      ? 'SSO-токен просрочен, обновите страницу'
      : err && err.name === 'JsonWebTokenError'
        ? 'SSO-токен недействителен'
        : (err && err.message) || 'Ошибка SSO';
    logger.warn(`SSO accept: ${msg}`, 'auth');
    return res.status(401).json({ error: msg });
  }
}

function readSession(req) {
  const raw = (req.cookies && req.cookies.auth_token)
    || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || '';
  if (!raw) return null;
  return jwt.verify(raw, config.sessionSecret);
}

// Кладёт req.owner. В standalone (authEnabled=false) владелец = 'local' и
// авторизация не требуется. Иначе — из сессионной куки, иначе 401.
function ownerMiddleware(req, res, next) {
  if (!config.authEnabled) {
    req.owner = 'local';
    req.roles = ['admin'];
    return next();
  }
  try {
    const session = readSession(req);
    if (!session || !session.userId) {
      return res.status(401).json({ error: 'Не авторизован' });
    }
    req.owner = String(session.userId);
    req.roles = Array.isArray(session.roles) ? session.roles : [];
    return next();
  } catch {
    return res.status(401).json({ error: 'Сессия недействительна' });
  }
}

// Кто залогинен (для фронта). Не валит запрос, просто говорит статус.
function whoAmI(req, res) {
  if (!config.authEnabled) {
    return res.json({ authEnabled: false, user: { id: 'local' } });
  }
  try {
    const session = readSession(req);
    if (session && session.userId) {
      return res.json({
        authEnabled: true,
        user: {
          id: String(session.userId),
          email: session.email || '',
          roles: session.roles || [],
          buyerCode: session.buyerCode || '',
        },
      });
    }
  } catch { /* нет валидной сессии */ }
  return res.status(401).json({ authEnabled: true, user: null });
}

module.exports = { handleSsoAccept, ownerMiddleware, whoAmI };
