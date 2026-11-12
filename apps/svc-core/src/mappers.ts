import type { MessageInitShape } from "@bufbuild/protobuf";
import type { UserSchema } from "@streamix/proto";

type UserRow = {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
  approvedAt: Date | null;
  isAdmin: boolean;
};

export function toTimestamp(date: Date): { seconds: bigint; nanos: number } {
  return { seconds: BigInt(Math.floor(date.getTime() / 1000)), nanos: 0 };
}

export function toUserMsg(u: UserRow): MessageInitShape<typeof UserSchema> {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    approved: u.approvedAt !== null,
    isAdmin: u.isAdmin,
    createdAt: toTimestamp(u.createdAt),
  };
}
