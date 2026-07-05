// Gameplay GUI lives under ./app. The legacy line-by-line port (panels,
// scrollbar, news, graph, calculator, canvas, worldbuilder) was retired in
// favor of the Preact-based app — see ui/GUI_PLAN.md. The Calculator and
// WorldBuilder UIs are not part of the gameplay GUI rebuild and will be
// rebuilt later.
export { App } from './app/App';
