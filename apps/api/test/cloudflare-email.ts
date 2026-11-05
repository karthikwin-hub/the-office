/** Node has no `cloudflare:email`; tests read what would have been sent. */
export class EmailMessage {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly raw: string,
  ) {}
}
