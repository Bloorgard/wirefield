# Архитектура

## Общая схема

WIRES — статическое приложение без backend и серверного состояния. Браузер загружает `index.html` и три ES-модуля. `npm run build` копирует только эти четыре public assets в `dist/` для публикации.

```text
index.html
├── разметка и CSS
├── UI и interactions
└── physics loop

src/model.js
├── constants и model limits
├── normalizeModel
└── pin/grid helpers

src/wires-format.js
├── parseWires
└── serializeWires

src/collision.js
├── pin spatial index
├── segment query
└── collision response
```

Unit-тесты используют `node:test`. Browser suite управляет Chromium через CDP без сторонних npm-зависимостей.

## Модель данных

```js
{
  version: 1,
  cell: 44,
  background: '#102cff',
  pointMode: 'white',
  gridVisible: true,
  wires: [
    {
      id: '0001',
      x: 7,
      y: 2,
      length: 10,
      color: '#102cff',
      endX: 20,
      endY: 7
    }
  ]
}
```

`pointMode` принимает `white`, `wire` или `background`. Legacy-поле `pointsMatchBackground` мигрирует во время нормализации. `endX` и `endY` присутствуют у закреплённого хвоста.

Модель ограничена 1000 жгутами. Parser отклоняет превышение. `normalizeModel` ограничивает внешние данные, а Add, Duplicate, Brush и Alt-copy проверяют ёмкость до изменения state.

## Runtime-физика

Каждый жгут получает runtime-массив внутренних точек. Старт и закреплённый хвост выступают ограничениями. Verlet-подобный шаг использует гравитацию, демпфирование и десять проходов коррекции расстояния.

После drag запускается release-фаза на 90 кадров. Idle-жгут не пересчитывает готовый SVG path без движения. При `prefers-reduced-motion: reduce` runtime использует прямую интерполяцию.

## Spatial collision index

`buildPinSpatialIndex()` строит hash пинов, когда коллизии включены. Индекс кешируется и пересобирается только после изменения модели — `syncScene()` сбрасывает кеш — либо при смене размера клетки. Сегмент запрашивает buckets вокруг своего bounding box, расширенного на clearance. Кандидаты сортируются по исходному порядку пинов, поэтому contact response детерминирован.

В benchmark на 1000 жгутов число distance checks уменьшилось с 15 984 000 до 124 958, то есть в 127.9 раза. Время зависит от машины и не используется как CI threshold. Benchmark сверяет одинаковое число контактов legacy и spatial paths.

## Взаимодействия

- тело жгута выбирает объект; Alt/Option включает copy drag;
- start и tail handles используют canonical point selection;
- рамка и Cmd/Meta selection записывают те же point keys;
- стрелки двигают выбранные точки на клетку, `Shift` на пять;
- пустой холст отвечает за pan или рамку;
- кисть и ластик обрабатывают клетки между pointer samples;
- grip слоя изменяет порядок.

Обычный body drag отключён. `pointercancel` откатывает незавершённую операцию к снимку перед началом действия.

## Список слоёв и карточка

`renderUI()` перестраивает список целиком, но строку получает только `.item-main`. Карточку настроек и панель действий строит `layerCard(wire, index)` — и только для выбранной строки, поскольку CSS показывает их лишь у `.item.primary`. На 1000 жгутов список занимает 6045 узлов вместо 45006, а `renderUI` укладывается в ~43 мс вместо ~172 мс.

Ту же `layerCard` вызывает `renderCompactCard()` для нижней панели на узких экранах, поэтому мобильный инспектор и десктопная карточка не могут разойтись: контролы и их обработчики создаются одним кодом. Панель показывает карточку выбранного жгута, подсказку без выбора и ничего в режиме кисти.

## Persistence

| Ключ | Назначение |
|---|---|
| `wires-v2` | модель рисунка |
| `wires-view-v1` | pan и zoom |
| `wires-brush-length` | длина кисти |
| `wires-brush-color` | цвет кисти |

`readStorage()` и `writeStorage()` изолируют browser storage errors. При quota failure текущая вкладка продолжает работать, а `.wires` экспорт сериализует актуальный in-memory state.

Undo хранит до десяти JSON-снимков модели в памяти вкладки.

## Доступность

Панели инструментов имеют именованные группы. Toast работает как polite live region. Dialog связан с заголовком и пояснением. Динамические swatches получают accessible names. SVG start/tail handles доступны по Tab, выбираются Enter/Space и двигаются стрелками через тот же constraint path, что pointer drag.

## Оставшаяся граница рефакторинга

Чистая модель, формат и collision solver уже вынесены. Следующие безопасные кандидаты:

- `physics.js` для runtime integration и constraint loop;
- `interactions.js` для pointer/keyboard controllers;
- `ui.js` после стабилизации DOM contracts.

Каждый перенос должен сохранять unit tests, browser smoke и статическую публикацию. Незакрытые вопросы и отложенные идеи — в [бэклоге](BACKLOG.md).
