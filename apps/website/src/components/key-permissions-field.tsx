import { Checkbox } from "@media-ref/ui/components/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@media-ref/ui/components/field";

/**
 * The permissions of an API key: read is always on, submit is the choice. Used when creating a
 * key and on the MCP OAuth consent page, whose grant is an API key. `name` puts the submit
 * checkbox into a native form post.
 */
export function KeyPermissionsField({
  canSubmit,
  onCanSubmitChange,
  name,
}: {
  canSubmit: boolean;
  onCanSubmitChange: (canSubmit: boolean) => void;
  name?: string;
}) {
  return (
    <Field>
      <FieldLabel>权限</FieldLabel>
      <div className="flex flex-col gap-3 rounded-lg border border-border/70 bg-background/50 p-3">
        <Field orientation="horizontal">
          <Checkbox checked disabled />
          <FieldContent>
            <FieldTitle>查询媒体</FieldTitle>
            <FieldDescription>查媒体在哪个平台、对应第几集</FieldDescription>
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id="perm-submit"
            name={name}
            checked={canSubmit}
            onCheckedChange={(checked) => onCanSubmitChange(Boolean(checked))}
          />
          <FieldContent>
            <FieldLabel htmlFor="perm-submit" className="cursor-pointer">
              提交变更单
            </FieldLabel>
            <FieldDescription>让脚本替你提交变更单，补充或修正集数</FieldDescription>
          </FieldContent>
        </Field>
      </div>
    </Field>
  );
}
