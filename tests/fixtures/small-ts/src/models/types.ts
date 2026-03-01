export class UserRepository {
  private users: Map<number, unknown> = new Map()

  findById(id: number) {
    return this.users.get(id)
  }

  save(user: unknown) {
    this.users.set(Date.now(), user)
  }
}

export enum UserRole {
  Admin = 'admin',
  User = 'user',
  Guest = 'guest',
}
