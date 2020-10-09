export class HttpError extends Error {
    status: number;
    data?: any;
    constructor(status: number, data: any) {
        super(`Error: ${status}`);
        this.status = status;
        this.data = data;
    }
}
