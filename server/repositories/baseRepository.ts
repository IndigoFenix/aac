import { db } from "../db";

export abstract class BaseRepository {
  protected db = db;
}
