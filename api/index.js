const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const nodeFetch = require("node-fetch");

const app = express();

// Список целевых серверов
const targets = [
  { url: "https://jackbox-d4d.glitch.me", status: "unknown", weight: 1 },
  { url: "https://jb-srv.oned4d.cc", status: "unknown", weight: 2 },
  { url: "https://jbox.oned4d.cc", status: "unknown", weight: 2 },
  { url: "https://jb-ecast.klucva.ru", status: "unknown", weight: 3 },
  { url: "https://rujackbox.vercel.app", status: "unknown", weight: 3 },
];

// Хранилище для сессий клиентов (IP -> { server, expiresAt })
const clientSessions = {};

// Интервал для проверки состояния серверов (каждые 120 секунд)
setInterval(checkServerStatuses, 120000);

// Middleware для обработки запроса к /favicon.ico
app.get("/favicon.ico", (req, res) => {
  res.status(204).end(); // Возвращаем пустой ответ без содержимого
});

// Middleware для корневого пути (/) — показываем HTML-страницу
app.use("/", (req, res, next) => {
  if (req.path === "/") {
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Load Balancer Status</title>
        <!-- Подключение Bootstrap -->
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
        <!-- Подключение Font Awesome для иконок -->
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" rel="stylesheet">
        <!-- Подключение Google Fonts -->
        <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" rel="stylesheet">
        <style>
          body {
            background-color: #f8f9fa;
            font-family: 'Poppins', sans-serif; /* Используем Poppins */
            color: #333;
          }
          .card {
            margin-top: 50px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
          }
          .status-up {
            color: green;
            font-weight: bold; /* Жирный шрифт */
          }
          .status-down {
            color: red;
          }
          .logo {
            height: 40px;
            margin-right: 10px;
          }
          .server-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 15px;
            border-bottom: 1px solid #ddd;
          }
          .server-item:last-child {
            border-bottom: none;
          }
          .server-status {
            display: flex;
            align-items: center;
            gap: 10px; /* Расстояние между иконкой и текстом */
          }
          .server-url {
            font-size: 1rem;
            color: #555;
          }
          .server-status i {
            font-size: 1.2rem; /* Размер иконки */
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="row justify-content-center">
            <div class="col-md-8">
              <div class="card">
                <div class="card-header bg-primary text-white d-flex align-items-center">
                  <img src="https://via.placeholder.com/50" alt="Logo" class="logo">
                  <h3 class="mb-0">Состояние серверов</h3>
                </div>
                <div class="card-body">
                  <div class="d-flex justify-content-end mb-3">
                    <button class="btn btn-primary" onclick="location.reload()">Обновить состояние</button>
                  </div>
                  <ul style="list-style: none; padding: 0;">
                    ${targets
                      .map(
                        (target) =>
                          `<li class="server-item">
                             <span class="server-url">${target.url}</span>
                             <span class="server-status ${
                               target.status === "up" ? "status-up" : "status-down"
                             }">
                               <i class="${
                                 target.status === "up" ? "fas fa-check-circle" : "fas fa-times-circle"
                               }"></i>
                               <span>${
                                 target.status === "up" ? "Доступен" : "Недоступен"
                               }</span>
                             </span>
                           </li>`
                      )
                      .join("")}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/js/bootstrap.bundle.min.js"></script>
      </body>
      </html>
    `);
  }

  // Получаем IP-адрес клиента
  const clientIP = getClientIP(req);

  // Проверяем, есть ли активная сессия для этого клиента
  const session = getSessionForClient(clientIP);

  if (session && session.server.status === "up") {
    console.log(`Reusing server for client ${clientIP}: ${session.server.url}`);
    proxyRequest(req, res, session.server.url);
    return;
  }

  // Если нет активной сессии или сервер недоступен, выбираем новый сервер
  const selectedTarget = selectTargetByIPHash(clientIP);
  if (!selectedTarget) {
    return res.status(503).send("No available servers.");
  }

  // Создаем новую сессию для клиента
  createSessionForClient(clientIP, selectedTarget);

  console.log(`New server assigned to client ${clientIP}: ${selectedTarget.url}`);
  proxyRequest(req, res, selectedTarget.url);
});

// Функция для выбора сервера по IP Hash
function selectTargetByIPHash(clientIP) {
  const availableTargets = targets.filter((target) => target.status === "up");
  if (availableTargets.length === 0) return null;

  // Вычисляем хэш IP-адреса
  let hash = 0;
  for (let i = 0; i < clientIP.length; i++) {
    hash += clientIP.charCodeAt(i);
  }

  // Выбираем сервер на основе хэша
  const index = hash % availableTargets.length;
  return availableTargets[index];
}

// Функция для создания новой сессии для клиента
function createSessionForClient(clientIP, server) {
  const sessionTimeout = 360 * 1000; // 6 минут
  clientSessions[clientIP] = {
    server,
    expiresAt: Date.now() + sessionTimeout,
  };
}

// Функция для получения текущей сессии клиента
function getSessionForClient(clientIP) {
  const session = clientSessions[clientIP];
  if (session && session.expiresAt > Date.now()) {
    return session;
  }

  // Удаляем истекшую сессию
  if (session) {
    delete clientSessions[clientIP];
  }

  return null;
}

// Middleware для проксирования запроса с обработкой ошибок и ретраями
function proxyRequest(req, res, targetURL) {
  const proxy = createProxyMiddleware({
    target: targetURL,
    changeOrigin: true,
    onError: (err, req, res) => {
      console.error(`Error proxying request to ${targetURL}:`, err.message);

      // Попытка перенаправить на другой сервер
      const backupTarget = selectTargetByIPHash(getClientIP(req));
      if (backupTarget) {
        console.log(`Retrying request on backup server: ${backupTarget.url}`);
        proxyRequest(req, res, backupTarget.url);
      } else {
        res.status(503).send("All servers are unavailable.");
      }
    },
    logLevel: "debug", // Включение логирования
    onProxyReq: (proxyReq, req, res) => {
      console.log(`Forwarding request to ${targetURL}`);
    },
    onProxyRes: (proxyRes, req, res) => {
      const startTime = Date.now();
      const duration = Date.now() - startTime;
      console.log(
        `Request from ${getClientIP(req)} to ${req.url} completed in ${duration}ms`
      );
    },
  });

  proxy(req, res, () => {});
}

// Функция для получения IP-адреса клиента
function getClientIP(req) {
  const forwardedIps = req.headers["x-forwarded-for"];
  if (forwardedIps) {
    return forwardedIps.split(",")[0].trim();
  }
  return req.connection.remoteAddress || "unknown";
}

// Функция для проверки состояния серверов с использованием Fetch API
async function checkServerStatus(url) {
  try {
    const response = await nodeFetch(url, { timeout: 3000 });
    return response.ok ? "up" : "down";
  } catch (error) {
    return "down";
  }
}

// Периодическая проверка состояния серверов
async function checkServerStatuses() {
  for (const target of targets) {
    const status = await checkServerStatus(target.url);
    if (status !== target.status) {
      console.log(`${target.url} status changed to ${status}`);
      target.status = status;
    }
  }
}

// Экспорт функции для Vercel
module.exports = (req, res) => {
  app.handle(req, res);
};

// Запуск сервера
app.listen(process.env.PORT, async () => {
  console.log(`Load balancer is running on port ${process.env.PORT}`);
  console.log("Checking server statuses at startup...");
  await checkServerStatuses(); // Проверяем состояние серверов при запуске
});
