# WIRES / Wirefield

WIRES — локальный визуальный редактор физических жгутов. Он работает как статическое веб-приложение, хранит рисунок в браузере и поддерживает человекочитаемый формат `.wires`. Wirefield — имя публичного репозитория.

Live-версия: <https://wires.pustota.link/>

## Возможности

- SVG-холст с сеткой и физической анимацией;
- start/tail point selection, рамка и совместный drag;
- клавиатурный сдвиг точек стрелками, с `Shift` на пять клеток;
- кисть, ластик и закрепление хвоста;
- слои, мультивыбор и изменение порядка;
- Alt/Option copy drag;
- pan, zoom и управление гравитацией наклоном устройства;
- опциональные коллизии жгутов с пинами через spatial index;
- три фона и режимы точек `white`, `wire`, `background`;
- undo до десяти изменений;
- безопасное локальное автосохранение;
- импорт и экспорт `.wires`;
- мобильная панель с карточкой выбранного слоя и списком слоёв.

## Быстрый запуск

Нужен обычный HTTP-сервер, поскольку runtime использует ES modules:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Откройте <http://127.0.0.1:8765/>.

## Проверки

Для полного прогона нужны Node.js 22, Python 3 и Chromium:

```bash
npm test
```

Отдельные команды:

```bash
npm run test:unit
npm run test:smoke
npm run benchmark:collision
```

Unit-тесты проверяют модель, `.wires` parser/serializer и spatial collision index. Smoke harness запускает временный Chromium через CDP и не затрагивает пользовательский профиль. Браузер ищется в стандартных местах macOS и Linux; другой путь задаётся через `CHROME_BIN`.

## Структура

```text
index.html                  UI, interactions и physics loop
src/model.js                модель, нормализация и ограничения
src/wires-format.js         parser/serializer .wires
src/collision.js            spatial index и collision response
tests/*.test.mjs            unit-тесты
tests/smoke.mjs             browser regression suite
benchmarks/collision.mjs    legacy/spatial comparison
```

## Документы

- [Руководство пользователя](docs/USAGE.md)
- [Формат `.wires`](docs/WIRES_FORMAT.md)
- [Архитектура](docs/ARCHITECTURE.md)
- [QA](docs/QA.md)
- [Бэклог](docs/BACKLOG.md)
- [История изменений](CHANGELOG.md)

## Хранение данных

Рисунок хранится в `localStorage['wires-v2']`. Вид холста и настройки кисти используют отдельные ключи. При ошибке quota текущий документ остаётся в памяти вкладки, а интерфейс предлагает скачать recovery-копию `.wires`.

Приложение не отправляет рисунок на сервер. Для долговременной резервной копии нужен экспорт файла.

## Ограничения

- аккаунты, серверное хранение и совместное редактирование отсутствуют;
- undo history живёт только в текущей вкладке;
- sensor permissions и настоящие touch-жесты проверяются на физических устройствах;
- UI, interactions и physics loop ещё частично связаны внутри `index.html`.

## Публикация

Соберите минимальный static output:

```bash
npm run build
```

`dist/` содержит:

```text
index.html
src/model.js
src/wires-format.js
src/collision.js
```

Тесты, benchmark, документация и `.git` в live-раздачу не входят. Production публикуется через `deployctl` после полного QA.
