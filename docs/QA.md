# QA

## Полный запуск

```bash
npm test
```

Требования:

- Node.js 22;
- Python 3;
- Chromium или Google Chrome.

Harness сам ищет Chromium в стандартных местах macOS и Linux. Другой browser binary:

```bash
CHROME_BIN=/path/to/chrome npm test
```

Live-проверка:

```bash
WIRES_URL=https://wires.pustota.link/ npm run test:smoke
```

Без `WIRES_URL` harness поднимает HTTP-сервер на `127.0.0.1:8765`. Chromium использует временный профиль, который удаляется после прогона.

## Unit tests

```bash
npm run test:unit
```

Текущий набор содержит 14 тестов для:

- нормализации и legacy migration;
- model limits, IDs, координат и занятых клеток;
- tail minimum и pin cells;
- разведения стартов и закреплённых хвостов по разным клеткам;
- `.wires` round-trip и строгого parser;
- лимитов файла и числа жгутов;
- spatial index, порядка кандидатов и collision response.

Успешный прогон заканчивается `14 tests passed` в TAP-отчёте.

## Browser smoke

```bash
npm run test:smoke
```

Текущий набор содержит 36 сценариев. Он проверяет стартовый рисунок, keyboard/undo, Add/Delete, границу 1000, `.wires`, storage recovery, mobile gestures, point selection, group drag, layer reorder, zoom, toolbar, фоны, point modes, grid semantics, layout geometry, компактную карточку слоя на мобильном, sensor gravity и collision behavior.

Отдельный accessibility scenario проверяет:

- polite live status;
- dialog labels и description;
- роли control groups;
- названия zoom и color controls;
- semantics SVG point handles;
- реальный ArrowRight nudge через keyboard event.

Успешный прогон заканчивается:

```text
36/36 checks passed
```

## Collision benchmark

```bash
npm run benchmark:collision
```

Benchmark сравнивает полный legacy scan и spatial index на 100, 500 и 1000 жгутах. Он считает distance checks, измеряет локальное время и требует совпадения числа контактов. Время является диагностикой; CI не применяет performance threshold.

Последний Radxa-прогон для 1000 жгутов:

```text
legacy checks: 15 984 000
spatial checks: 124 958
reduction: 127.9x
```

## Ограничения автоматизации

- synthetic touch не заменяет физический телефон;
- sensor permissions и ориентация осей проверяются на устройствах;
- visual defects требуют screenshot QA;
- dialog round-trip не заменяет проверку системного file-picker и скачанного Blob;
- screen-reader UX требует ручной проверки VoiceOver или NVDA.

## GitHub Actions

`.github/workflows/quality.yml` запускается для push и pull request в `main`:

```bash
npm run build
node --check tests/smoke.mjs
npm test
npm run benchmark:collision
git show --check --format= HEAD
```

## Перед production

```bash
npm test
npm run benchmark:collision
npm run build
node --check tests/smoke.mjs
git diff --check
```

Публикуется каталог `dist/`, который содержит:

```text
index.html
src/model.js
src/wires-format.js
src/collision.js
```

После staging deploy обязательны browser smoke, console check и визуальная проверка desktop/mobile.
