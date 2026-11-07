import { Component, type ReactNode } from "react";
import { safeRpcError } from "../../shared/rpc";
export default class RpcSectionBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: safeRpcError(error) };
  }
  render() {
    if (this.state.error)
      return (
        <section className="projects">
          <div className="error" role="alert">
            Не удалось открыть раздел: {this.state.error}. Проверьте настройки
            тестового RPC и повторите попытку.
          </div>
          <div className="rpc-padding">
            <button
              className="secondary"
              onClick={() => this.setState({ error: null })}
            >
              Повторить загрузку раздела
            </button>
          </div>
        </section>
      );
    return this.props.children;
  }
}
