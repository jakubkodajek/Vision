import { BookOpen, Bot, FolderGit2, ListChecks } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "../components/primitives";
import type { Section } from "../types";

const SECTIONS: Record<
  Exclude<Section, "home" | "settings" | "tools" | "mcp">,
  { title: string; icon: ReactNode; description: string }
> = {
  projects: {
    title: "Projects",
    icon: <FolderGit2 width={28} height={28} />,
    description:
      "Add local repositories, pick their setup command and see every task per project. Planned for a later version.",
  },
  agents: {
    title: "Agents",
    icon: <Bot width={28} height={28} />,
    description:
      "Built-in agent templates, your own versions of them and their history. Planned for a later version.",
  },
  tasks: {
    title: "Tasks",
    icon: <ListChecks width={28} height={28} />,
    description: "Every task with its runs, status and approvals across projects. Planned for a later version.",
  },
  knowledge: {
    title: "Knowledge",
    icon: <BookOpen width={28} height={28} />,
    description:
      "Project memory, decisions and lessons the agents read before they work. Planned for a later version.",
  },
};

/** Placeholder for a section whose feature is not built yet. */
/** Sections that have their own view instead of a placeholder. */
type RealSection = "home" | "settings" | "tools" | "mcp";

export function SectionView({ section }: { section: Exclude<Section, RealSection> }) {
  const info = SECTIONS[section];
  return (
    <div className="section-view">
      <header className="view-header">
        <div className="view-header-main">
          <h2 className="view-title" tabIndex={-1} data-focus-fallback>
            {info.title}
          </h2>
        </div>
      </header>
      <div className="section-body">
        <EmptyState
          icon={info.icon}
          title={`${info.title} are not available yet`}
          description={info.description}
        />
      </div>
    </div>
  );
}
