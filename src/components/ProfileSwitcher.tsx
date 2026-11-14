import { Check, ChevronsUpDown, Plus, Settings2 } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cx } from "../lib/cx";
import type { Profile } from "../types";

export interface ProfileSwitcherProps {
  profiles: readonly Profile[];
  activeId: string;
  onSwitch: (id: string) => void;
  /** Shows an enabled "New profile…" entry. */
  onNewProfile?: () => void;
  /** Enables the "Manage profiles" entry; without it the entry is shown disabled. */
  onManageProfiles?: () => void;
  /** Controlled open state, so the command palette can open the menu too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collapsed?: boolean;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/** Profile avatar: initials on the profile accent. */
export function ProfileAvatar({ profile, size = "md" }: { profile: Profile; size?: "sm" | "md" }) {
  return (
    <span className={cx("avatar", `avatar-${size}`)} data-accent={profile.accent} aria-hidden="true">
      {initials(profile.name)}
    </span>
  );
}

/**
 * Profile switcher at the top of the sidebar (menu button pattern,
 * https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/). "New profile…" and "Manage
 * profiles" are enabled when their handlers are given.
 */
export function ProfileSwitcher({
  profiles,
  activeId,
  onSwitch,
  onNewProfile,
  onManageProfiles,
  open,
  onOpenChange,
  collapsed = false,
}: ProfileSwitcherProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [initialFocus, setInitialFocus] = useState<"current" | "last">("current");
  const menuId = useId();
  const active = profiles.find((p) => p.id === activeId) ?? profiles[0];
  if (!active) return null;

  const close = (restoreFocus: boolean) => {
    onOpenChange(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setInitialFocus(event.key === "ArrowUp" ? "last" : "current");
      onOpenChange(true);
    }
  };

  return (
    <div className={cx("profile-switcher", collapsed && "is-collapsed")}>
      <button
        ref={buttonRef}
        type="button"
        className="profile-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={collapsed ? `${active.name} profile, switch profile` : undefined}
        title={collapsed ? `Profile: ${active.name}` : undefined}
        onClick={() => {
          setInitialFocus("current");
          onOpenChange(!open);
        }}
        onKeyDown={onButtonKey}
      >
        <ProfileAvatar profile={active} />
        {!collapsed && (
          <>
            <span className="profile-text">
              <span className="profile-name">{active.name}</span>
              <span className="profile-account">{active.account}</span>
            </span>
            <span className="visually-hidden">Switch profile</span>
            <ChevronsUpDown className="profile-chevron" width={14} height={14} aria-hidden="true" />
          </>
        )}
      </button>
      {open && (
        <ProfileMenu
          id={menuId}
          profiles={profiles}
          activeId={active.id}
          initialFocus={initialFocus}
          buttonRef={buttonRef}
          onSelect={(id) => {
            onSwitch(id);
            close(true);
          }}
          actions={menuActions(onNewProfile, onManageProfiles)}
          onClose={close}
        />
      )}
    </div>
  );
}

interface MenuAction {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  /** Omitted for a disabled entry. */
  run?: () => void;
}

function menuActions(onNewProfile?: () => void, onManageProfiles?: () => void): MenuAction[] {
  const manageIcon = <Settings2 width={14} height={14} aria-hidden="true" />;
  const actions: MenuAction[] = [];
  if (onNewProfile) {
    actions.push({
      id: "new",
      label: "New profile…",
      icon: <Plus width={14} height={14} aria-hidden="true" />,
      run: onNewProfile,
    });
  }
  actions.push(
    onManageProfiles
      ? { id: "manage", label: "Manage profiles", icon: manageIcon, run: onManageProfiles }
      : { id: "manage", label: "Manage profiles…", hint: "Coming with profile management", icon: manageIcon },
  );
  return actions;
}

function ProfileMenu({
  id,
  profiles,
  activeId,
  initialFocus,
  buttonRef,
  onSelect,
  actions,
  onClose,
}: {
  id: string;
  profiles: readonly Profile[];
  activeId: string;
  initialFocus: "current" | "last";
  buttonRef: RefObject<HTMLButtonElement | null>;
  onSelect: (id: string) => void;
  actions: readonly MenuAction[];
  onClose: (restoreFocus: boolean) => void;
}) {
  const itemCount = profiles.length + actions.length;
  const [focusIndex, setFocusIndex] = useState(() =>
    initialFocus === "last"
      ? itemCount - 1
      : Math.max(
          0,
          profiles.findIndex((p) => p.id === activeId),
        ),
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    itemRefs.current[focusIndex]?.focus();
  }, [focusIndex]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) onClose(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [buttonRef, onClose]);

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setFocusIndex((i) => (i + 1) % itemCount);
        break;
      case "ArrowUp":
        event.preventDefault();
        setFocusIndex((i) => (i - 1 + itemCount) % itemCount);
        break;
      case "Home":
        event.preventDefault();
        setFocusIndex(0);
        break;
      case "End":
        event.preventDefault();
        setFocusIndex(itemCount - 1);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
        break;
      case "Tab":
        onClose(false);
        break;
    }
  };

  return (
    <div
      ref={menuRef}
      id={id}
      role="menu"
      aria-label="Profiles"
      className="menu profile-menu"
      onKeyDown={onMenuKey}
    >
      {profiles.map((profile, index) => {
        const checked = profile.id === activeId;
        return (
          <div
            key={profile.id}
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            role="menuitemradio"
            aria-checked={checked}
            tabIndex={index === focusIndex ? 0 : -1}
            className="menu-item"
            onClick={() => {
              onSelect(profile.id);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(profile.id);
              }
            }}
          >
            <ProfileAvatar profile={profile} size="sm" />
            <span className="menu-item-text">
              <span>{profile.name}</span>
              <span className="menu-item-hint">{profile.account}</span>
            </span>
            {checked && <Check className="menu-item-check" width={14} height={14} aria-hidden="true" />}
          </div>
        );
      })}
      <div role="separator" className="menu-separator" />
      {actions.map((action, offset) => {
        const index = profiles.length + offset;
        const activate = action.run
          ? () => {
              onClose(false);
              action.run?.();
            }
          : undefined;
        return (
          <div
            key={action.id}
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            role="menuitem"
            aria-disabled={activate ? undefined : "true"}
            tabIndex={focusIndex === index ? 0 : -1}
            className={cx("menu-item", !activate && "is-disabled")}
            onClick={activate}
            onKeyDown={(event) => {
              if (activate && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                activate();
              }
            }}
          >
            {action.icon}
            <span className="menu-item-text">
              <span>{action.label}</span>
              {action.hint && <span className="menu-item-hint">{action.hint}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
