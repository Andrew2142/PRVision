import { IsIn } from "class-validator";

/** PATCH /api/repositories/:id — user settings of a registered repository. */
export class RepositoryUpdateDTO {
  /** Screen size screenshots are taken at: desktop 1280×800, tablet 768×1024, mobile 390×844. */
  @IsIn(["desktop", "tablet", "mobile"])
  renderViewport!: "desktop" | "tablet" | "mobile";
}
