import { render } from "preact";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("缺少 #app 挂载点");
render(<App />, root);
