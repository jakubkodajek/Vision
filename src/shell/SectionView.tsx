import { BookOpen, Bot, FolderGit2, ListChecks } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "../components/primitives";
import type { Section } from "../types";

const SECTIONS: Record<
  Exclude<Section, "home" | "settings">,
  { title: string; icon: ReactNode; description: string }
> = {
  projects: {
    title: "Projects",
    icon: <FolderGit2 width={28} height={28} />,
    description:
      "Add local repositories, pick their setup command and see every task per project. Arrives with milestone M3.",
  },
  agents: {
    title: "Agents",
    icon: <Bot width={28} height={28} />,
    description:
      "Built-in agent templates, your forks and their versions. Arrives with Agent Studio in milestone M5.",
  },
  tasks: {
    title: "Tasks",
    icon: <ListChecks width={28} height={28} />,
    description: "Every task with its runs, status and approvals across projects. Arrives with milestone M3.",
  },
  knowledge: {
    title: "Knowledge",
    icon: <BookOpen width={28} height={28} />,
    description:
      "Project memory, decisions and lessons the agents read before they work. Arrives with milestone M4.",
  },
};

/** Placeholder for a section whose feature is not built yet. */
export function SectionView({ section }: { section: Exclude<Section, "home" | "settings"> }) {
  const info = SECTIONS[section];
  return (
    <div className="section-view">
      <header className="view-header">
        <div className="view-header-main">
          <h2 className="view-title">{info.title}</h2>
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
