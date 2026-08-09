# Changelog

## Unreleased

- Все пути создания останавливаются на лимите 1000 жгутов до изменения документа.
- Ошибки `localStorage` больше не прерывают работу вкладки; интерфейс предлагает выгрузить актуальный `.wires`.
- Добавлены regression-тесты границы модели и `QuotaExceededError`; smoke suite содержит 35 сценариев.
- Добавлен GitHub Actions workflow для syntax, browser smoke и whitespace checks.
- Добавлены три swatch-фона и режимы точек `white`, `wire`, `background`.
- Контрастные точки и круг режима становятся синими на белом фоне.
- Исправлены group point drag, рамочное выделение, grid active state и геометрия compact controls.
- Стартовый чистый документ обновлён до композиции из 48 жгутов.
- Архитектура, формат `.wires`, пользовательское руководство и QA синхронизированы с runtime.
- Модель, нормализация и `.wires` parser/serializer вынесены в чистые ES-модули с unit-тестами.
- Collision solver использует spatial index; benchmark на 1000 жгутов сокращает distance checks в 127.9 раза.
- Collision correction переведён на barycentric weights; contact projection внутри constraint passes и физический запас уменьшают дрожание и проскакивание через пины.
- Кнопки гравитации и коллизий сохраняют постоянные подписи; активность показывается только заливкой и `aria-pressed`.
- SVG start/tail handles получили keyboard selection и сдвиг стрелками; toast, dialog и динамические controls получили доступные имена и роли.
- Статический release теперь включает `index.html` и runtime-модули из `src/`; `npm run build` создаёт минимальный `dist/`.

## 2026-08-06

- Добавлен smoke-test без npm-зависимостей.
- Добавлены проверки mobile touch drag и `pointercancel`.
- Добавлен fallback для Clipboard API.
- Добавлено уведомление после автоматического ремонта сохранённых данных.
- Парсер `.wires` стал отклонять лишние токены в строке `wire`.
- Исправлен первичный рендер жгутов до перехода physics loop в idle.
- Исправлена release-фаза физики после drag.
- Добавлена компактная сворачиваемая панель слоёв на мобильных экранах.

## Baseline

- Локальный SVG-редактор физических жгутов.
- Локальное сохранение через `localStorage`.
- Импорт и экспорт человекочитаемого `.wires`.
- Кисть, ластик, pan, zoom, слои и undo.
