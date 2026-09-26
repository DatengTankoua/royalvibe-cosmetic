"use client";

import {
  DELEGABLE_PERMISSIONS,
  PERMISSION_LABELS,
  type DelegablePermission,
} from "@/lib/organization-permissions";

interface PermissionCheckboxesProps {
  value: DelegablePermission[];
  onChange: (value: DelegablePermission[]) => void;
  // Anti-escalade côté UX : n'offre jamais plus que les permissions
  // effectives de l'acteur courant (le backend refuse de toute façon tout
  // dépassement, ceci évite juste une action vouée à échouer).
  assignable: readonly DelegablePermission[];
  disabled?: boolean;
}

export function PermissionCheckboxes({
  value,
  onChange,
  assignable,
  disabled,
}: PermissionCheckboxesProps) {
  const options = DELEGABLE_PERMISSIONS.filter((p) => assignable.includes(p));

  const toggle = (permission: DelegablePermission) => {
    if (value.includes(permission)) {
      onChange(value.filter((p) => p !== permission));
    } else {
      onChange([...value, permission]);
    }
  };

  if (options.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Aucune permission supplémentaire disponible.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map((permission) => (
        <label key={permission} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.includes(permission)}
            onChange={() => toggle(permission)}
            disabled={disabled}
            className="h-4 w-4 rounded border-input"
          />
          {PERMISSION_LABELS[permission]}
        </label>
      ))}
    </div>
  );
}
