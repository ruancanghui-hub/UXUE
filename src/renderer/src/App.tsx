import { BenchApp } from './BenchApp';
import { ProjectApp } from './ProjectApp';

export function App() {
  return window.anye.flags.autoBench ? <BenchApp /> : <ProjectApp />;
}
