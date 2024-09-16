import { ParcnetAPI, Zapp, connect } from "@parcnet-js/app-connector";
import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState
} from "react";

export type ClientConnectionInfo = {
  url: string;
  type: "iframe";
};

export enum ClientConnectionState {
  CONNECTING,
  CONNECTED
}

export const ParcnetClientContext = createContext<ClientState>({
  state: ClientConnectionState.CONNECTING,
  ref: null
});

type ClientIframeState =
  | {
      state: ClientConnectionState.CONNECTING;
      ref: React.RefObject<HTMLDivElement> | null;
    }
  | {
      state: ClientConnectionState.CONNECTED;
      z: ParcnetAPI;
      ref: React.RefObject<HTMLDivElement>;
    };

type ClientState = ClientIframeState;

export function ParcnetClientProvider({
  zapp,
  connectionInfo,
  children
}: {
  zapp: Zapp;
  connectionInfo: ClientConnectionInfo;
  children: React.ReactNode;
}): ReactNode {
  if (connectionInfo.type === "iframe") {
    return (
      <ParcnetIframeProvider zapp={zapp} url={connectionInfo.url}>
        {children}
      </ParcnetIframeProvider>
    );
  }
}

export function ParcnetIframeProvider({
  zapp,
  url,
  children
}: {
  zapp: Zapp;
  url: string;
  children: React.ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  const [value, setValue] = useState<ClientState>({
    state: ClientConnectionState.CONNECTING,
    ref
  });

  useEffect(() => {
    if (ref.current) {
      void connect(zapp, ref.current, url).then((zupass) => {
        setValue({
          state: ClientConnectionState.CONNECTED,
          z: zupass,
          ref
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ParcnetClientContext.Provider value={value}>
      <div ref={ref}></div>
      {children}
    </ParcnetClientContext.Provider>
  );
}

type UseParcnetClient =
  | {
      connected: true;
      z: ParcnetAPI;
    }
  | {
      connected: false;
      z: Record<string, never>;
    };

export function useParcnetClient(): UseParcnetClient {
  const context = useContext(ParcnetClientContext);
  return context.state === ClientConnectionState.CONNECTED
    ? {
        connected: true,
        z: context.z
      }
    : {
        connected: false,
        z: {}
      };
}
