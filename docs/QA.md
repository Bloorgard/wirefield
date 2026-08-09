# QA

## Быстрый запуск

Из корня проекта:

```bash
npm test
```

Требования:

- Node.js с поддержкой ES modules, `fetch` и WebSocket;
- Python 3;
- Chromium или Google Chrome.

Локальный harness по умолчанию использует Chromium на Radxa:

```text
/home/hermesbot/.cache/ms-playwright/chromium-1234/chrome-linux/chrome
```

Другой браузер задаётся явно:

```bash
CHROME_BIN=/path/to/chrome npm test
```

Проверка live-версии:

```bash
WIRES_URL=https://wires.pustota.link/ npm test
```

Другой CDP-порт:

```bash
CDP_PORT=9333 npm test
```

Без `WIRES_URL` harness поднимает `python3 -m http.server` на `127.0.0.1:8765`. Chromium запускается с временным профилем, который удаляется после прогона. Пользовательский браузер и его `localStorage` не затрагиваются.

## Что проверяется

Текущий набор содержит 33 сценария:

1. чистый рендер стартового рисунка из 48 жгутов;
2. движение с клавиатуры и undo;
3. добавление и удаление;
4. граница 1000 жгутов для Add, Duplicate, Brush и Alt-copy;
5. round-trip `.wires` и строгий отказ от лишнего токена;
6. уведомление после нормализации сохранённых данных;
7. восстановление при `QuotaExceededError` в `localStorage`;
8. Clipboard fallback;
9. компактная мобильная панель;
10. запрет обычного body drag;
11. mobile touch drag и release-фаза;
12. mobile `pointercancel` с откатом;
13. совместное перемещение start и tail points;
14. Command/Meta selection и group drag;
15. рамочное выделение точек и group drag;
16. групповое изменение порядка слоёв;
17. координатная сортировка слоёв;
18. Alt-copy drag;
19. native zoom и встроенные иконки;
20. icon toolbar и верхняя кнопка Add;
21. три swatch-фона;
22. режимы точек `white`, `wire`, `background`;
23. состояние кнопки сетки;
24. геометрия desktop length controls;
25. контраст settings card для цветов жгута;
26. синтетическое device gravity событие;
27. mobile double-tap creation;
28. mobile length controls;
29. mobile pinch zoom;
30. release physics после drag;
31. pin collision;
32. wire-to-pin collision;
33. стабильность соседних пинов.

Успешный прогон заканчивается строкой:

```text
33/33 checks passed
```

Большинство сценариев явно загружает компактный fixture из трёх жгутов. Чистый старт проверяется отдельно на встроенном рисунке из 48 жгутов. Harness не обещает reset перед каждой отдельной assertion-группой; изоляцию обеспечивает временный профиль браузера и явные вызовы `reset()` на границах сценариев.

## Ограничения harness

- touch-события синтетические и не проверяют точность попадания пальцем;
- sensor permission, ориентацию осей и системные жесты нужно проверять на физических устройствах;
- visual defects требуют screenshot или browser vision;
- physics timing в headless Chromium не является физическим эталоном;
- dialog parser round-trip не заменяет отдельную проверку системного file-picker и скачанного Blob;
- collision performance на больших документах проверяется отдельным benchmark, а не функциональным smoke.

## GitHub Actions

Workflow `.github/workflows/quality.yml` запускается для push и pull request в `main`. Он использует Node.js 22 и системный Chrome на `ubuntu-latest`, затем выполняет:

```bash
node --check tests/smoke.mjs
npm test
git show --check --format= HEAD
```

## Перед production-публикацией

```bash
npm test
node --check tests/smoke.mjs
git diff --check
sha256sum index.html
```

В статический release входит только `index.html`. Тесты, документация, `.git` и пользовательские данные не публикуются.
