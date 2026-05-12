import type { FlightMode } from "./flightEvents";

export type QaTraceSettings = {
	enabled: boolean;
	mode: FlightMode;
	qaTraceSecret?: string | null;
};
