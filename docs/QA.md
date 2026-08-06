# QA

## Быстрый запуск

Из корня проекта:

```bash
npm test
```

Требования:

- Node.js с поддержкой ES modules, `fetch` и WebSocket;
- Python 3;
- Chromium.

По умолчанию harness использует Chromium:

```text
/home/hermesbot/.cache/ms-playwright/chromium-1234/chrome-linux/chrome
```

Путь можно изменить:

```bash
CHROME_BIN=/path/to/chrome npm test
```

## Дополнительные параметры

Проверка live или другого локального сервера:

```bash
WIRES_URL=https://wires.pustota.link/ npm test
```

Для другого CDP-порта:

```bash
CDP_PORT=9333 npm test
```

Если `WIRES_URL` не задан, harness сам поднимает `python3 -m http.server` на `127.0.0.1:8765`.

## Что проверяется

Текущий набор содержит 10 сценариев:

1. первичный рендер трёх жгутов;
2. движение стрелками и undo;
3. добавление и удаление;
4. round-trip `.wires` и отказ от лишнего токена;
5. уведомление после ремонта повреждённого `localStorage`;
6. Clipboard fallback;
7. компактная мобильная панель;
8. mobile touch drag и release-фаза;
9. mobile `pointercancel` с откатом;
10. desktop drag и release-фаза.

Успешный прогон заканчивается строкой:

```text
10/10 checks passed
```

## Состояние после QA

Перед каждым сценарием harness очищает `localStorage`. В конце он также перезагружает страницу, поэтому пользовательское состояние не переносится в следующий запуск.

При ручном QA нужно восстановить три исходных объекта:

```text
0001: x=7, y=2, length=10, color=#102cff
0002: x=12, y=4, length=9, color=#102cff
0003: x=16, y=1, length=11, color=#102cff
```

## Ограничения harness

- touch-события синтетические и не проверяют точность попадания пальцем;
- реальная прокрутка страницы, системные жесты и поведение клавиатуры телефона требуют ручной проверки;
- визуальные дефекты нужно подтверждать screenshot или browser vision проверкой;
- physics timing зависит от headless Chromium и не является физическим эталоном.

## Перед публикацией

```bash
npm test
git diff --check
sha256sum index.html
```

Публиковать нужно только статический `index.html`. `tests/`, `docs/`, `.git` и локальные данные пользователя в release не входят.
