import {WorkflowStepInputModel} from "cwlts/models/generic";
import {StepModel} from "cwlts/models/generic/StepModel";
import {WorkflowInputParameterModel} from "cwlts/models/generic/WorkflowInputParameterModel";
import {WorkflowModel} from "cwlts/models/generic/WorkflowModel";
import {WorkflowOutputParameterModel} from "cwlts/models/generic/WorkflowOutputParameterModel";
import {SVGPlugin} from "../plugins/plugin";
import {DomEvents} from "../utils/dom-events";
import {EventHub} from "../utils/event-hub";
import {Connectable} from "./connectable";
import {Edge as GraphEdge} from "./edge";
import {GraphNode} from "./graph-node";
import {StepNode} from "./step-node";
import {TemplateParser} from "./template-parser";

/**
 * @FIXME validation states of old and newly created edges
 */
export class Workflow {

    readonly eventHub: EventHub;
    readonly svgID = this.makeID();

    minScale = 0.2;
    maxScale = 2;

    domEvents: DomEvents;
    svgRoot: SVGSVGElement;
    workflow: SVGGElement;
    model: WorkflowModel;
    /** Scale of labels, they are different than scale of other elements in the workflow */
    labelScale                        = 1;
    private workflowBoundingClientRect;
    private plugins: SVGPlugin[]      = [];
    private handlersThatCanBeDisabled = [];
    private disposers: Function[]     = [];

    constructor(parameters: {
        svgRoot: SVGSVGElement,
        model: WorkflowModel,
        plugins?: SVGPlugin[]
    }) {
        this.svgRoot   = parameters.svgRoot;
        this.plugins   = parameters.plugins || [];
        this.domEvents = new DomEvents(this.svgRoot as any);

        this.svgRoot.classList.add(this.svgID);

        this.svgRoot.innerHTML = `
            <rect x="0" y="0" width="100%" height="100%" class="pan-handle" transform="matrix(1,0,0,1,0,0)"></rect>
            <g class="workflow" transform="matrix(1,0,0,1,0,0)"></g>
        `;

        this.workflow = this.svgRoot.querySelector(".workflow") as any;

        this.invokePlugins("registerWorkflow", this);


        this.eventHub = new EventHub([
            "connection.create",
            "app.create.step",
            "app.create.input",
            "app.create.output",
            "beforeChange",
            "afterChange",
            "afterRender",
            "selectionChange"
        ]);

        this.hookPlugins();
        this.draw(parameters.model);


        this.eventHub.on("afterRender", () => this.invokePlugins("afterRender"));
    }

    /** Current scale of the document */
    private _scale = 1;

    get scale() {
        return this._scale;
    }

    // noinspection JSUnusedGlobalSymbols
    set scale(scale: number) {
        this.workflowBoundingClientRect = this.svgRoot.getBoundingClientRect();

        const x = (this.workflowBoundingClientRect.right + this.workflowBoundingClientRect.left) / 2;
        const y = (this.workflowBoundingClientRect.top + this.workflowBoundingClientRect.bottom) / 2;

        this.scaleAtPoint(scale, x, y);
    }

    static canDrawIn(element: SVGElement): boolean {
        return element.getBoundingClientRect().width !== 0;
    }

    static makeConnectionPath(x1, y1, x2, y2, forceDirection: "right" | "left" | string = "right"): string {

        if (!forceDirection) {
            return `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`;
        } else if (forceDirection === "right") {
            const outDir = x1 + Math.abs(x1 - x2) / 2;
            const inDir  = x2 - Math.abs(x1 - x2) / 2;

            return `M ${x1} ${y1} C ${outDir} ${y1} ${inDir} ${y2} ${x2} ${y2}`;
        } else if (forceDirection === "left") {
            const outDir = x1 - Math.abs(x1 - x2) / 2;
            const inDir  = x2 + Math.abs(x1 - x2) / 2;

            return `M ${x1} ${y1} C ${outDir} ${y1} ${inDir} ${y2} ${x2} ${y2}`;
        }
    }

    draw(model: WorkflowModel = this.model) {
        console.time("Graph Rendering");

        // We will need to restore the transformations when we redraw the model, so save the current state
        const oldTransform = this.workflow.getAttribute("transform");

        const modelChanged = this.model !== model;

        if (modelChanged) {
            this.model = model;

            const stepChangeDisposer       = this.model.on("step.change", this.onStepChange.bind(this));
            const stepCreateDisposer       = this.model.on("step.create", this.onStepCreate.bind(this));
            const inputCreateDisposer      = this.model.on("input.create", this.onInputCreate.bind(this));
            const outputCreateDisposer     = this.model.on("output.create", this.onOutputCreate.bind(this));
            const stepInPortShowDisposer   = this.model.on("step.inPort.show", this.onInputPortShow.bind(this));
            const stepInPortHideDisposer   = this.model.on("step.inPort.hide", this.onInputPortHide.bind(this));
            const connectionCreateDisposer = this.model.on("connection.create", this.onConnectionCreate.bind(this));

            this.disposers.push(() => {
                stepChangeDisposer.dispose();
                stepCreateDisposer.dispose();
                inputCreateDisposer.dispose();
                outputCreateDisposer.dispose();
                stepInPortShowDisposer.dispose();
                stepInPortHideDisposer.dispose();
                connectionCreateDisposer.dispose();
            });

            this.invokePlugins("afterModelChange");
        }

        this.clearCanvas();

        const nodes = [
            ...this.model.steps,
            ...this.model.inputs,
            ...this.model.outputs
        ].filter(n => n.isVisible);

        /**
         * If there is a missing sbg:x or sbg:y property on any node model,
         * graph should be arranged to avoid random placement.
         */
        let arrangeNecessary = false;

        let nodeTemplate = "";

        for (let node of nodes) {
            const patched  = GraphNode.patchModelPorts(node);
            const missingX = isNaN(parseInt(patched.customProps["sbg:x"]));
            const missingY = isNaN(parseInt(patched.customProps["sbg:y"]));

            if (missingX || missingY) {
                arrangeNecessary = true;
            }

            nodeTemplate += GraphNode.makeTemplate(patched);

        }

        this.workflow.innerHTML += nodeTemplate;

        this.redrawEdges();

        console.timeEnd("Graph Rendering");
        console.time("Ordering");

        Array.from(this.workflow.querySelectorAll(".node")).forEach(e => {
            this.workflow.appendChild(e);
        });

        this.addEventListeners();

        this.workflow.setAttribute("transform", oldTransform);
        console.timeEnd("Ordering");

        this.scaleAtPoint(this.scale);


        this.invokePlugins("afterRender");
    }

    findParent(el: Element, parentClass = "node"): SVGGElement | undefined {
        let parentNode = el as Element;
        while (parentNode) {
            if (parentNode.classList.contains(parentClass)) {
                return parentNode as SVGGElement;
            }
            parentNode = parentNode.parentElement;
        }
    }

    /**
     * Retrieves a plugin instance
     * @param {{new(...args: any[]) => T}} plugin
     * @returns {T}
     */
    getPlugin<T extends SVGPlugin>(plugin: { new(...args: any[]): T }): T {
        return this.plugins.find(p => p instanceof plugin) as T;
    }

    on(event: string, handler) {
        this.eventHub.on(event, handler);
    }

    off(event, handler) {
        this.eventHub.off(event, handler);
    }

    /**
     * Scales the workflow to fit the available viewport
     */
    fitToViewport(): void {

        this.scaleAtPoint(1);

        Object.assign(this.workflow.transform.baseVal.getItem(0).matrix, {
            e: 0,
            f: 0
        });

        let clientBounds = this.svgRoot.getBoundingClientRect();
        let wfBounds     = this.workflow.getBoundingClientRect();
        const padding    = 100;

        if (clientBounds.width === 0 || clientBounds.height === 0) {
            throw new Error("Cannot fit workflow to the area that has no visible viewport.");
        }

        const verticalScale   = (wfBounds.height) / (clientBounds.height - padding);
        const horizontalScale = (wfBounds.width) / (clientBounds.width - padding);

        const scaleFactor = Math.max(verticalScale, horizontalScale);

        // Cap the upscaling to 1, we don't want to zoom in workflows that would fit anyway
        const newScale = Math.min(this.scale / scaleFactor, 1);
        this.scaleAtPoint(newScale);

        const scaledWFBounds = this.workflow.getBoundingClientRect();

        const moveY = clientBounds.top - scaledWFBounds.top + Math.abs(clientBounds.height - scaledWFBounds.height) / 2;
        const moveX = clientBounds.left - scaledWFBounds.left + Math.abs(clientBounds.width - scaledWFBounds.width) / 2;

        const matrix = this.workflow.transform.baseVal.getItem(0).matrix;
        matrix.e += moveX;
        matrix.f += moveY;
    }

    redrawEdges() {

        const highlightedEdges = new Set();

        Array.from(this.workflow.querySelectorAll(".edge")).forEach((el) => {
            if (el.classList.contains("highlighted")) {
                const edgeID = el.attributes["data-source-connection"].value + el.attributes["data-destination-connection"].value;
                highlightedEdges.add(edgeID);
            }
            el.remove();
        });


        const edgesTpl = this.model.connections
            .map(c => {
                const edgeId     = c.source.id + c.destination.id;
                const edgeStates = highlightedEdges.has(edgeId) ? "highlighted" : "";
                return GraphEdge.makeTemplate(c, this.workflow, edgeStates);
            })
            .reduce((acc, tpl) => acc + tpl, "");

        this.workflow.innerHTML = edgesTpl + this.workflow.innerHTML;
    }

    /**
     * Scale the workflow by the scaleCoefficient (not compounded) over given coordinates
     */
    scaleAtPoint(scale = 1, x = 0, y = 0): void {

        this._scale     = scale;
        this.labelScale = 1 + (1 - this._scale) / (this._scale * 2);

        const transform         = this.workflow.transform.baseVal;
        const matrix: SVGMatrix = transform.getItem(0).matrix;

        const coords = this.transformScreenCTMtoCanvas(x, y);

        matrix.e += matrix.a * coords.x;
        matrix.f += matrix.a * coords.y;
        matrix.a = matrix.d = scale;
        matrix.e -= scale * coords.x;
        matrix.f -= scale * coords.y;

        const nodeLabels = this.workflow.querySelectorAll(".node .label") as  NodeListOf<SVGPathElement>;

        for (let el of nodeLabels) {
            const matrix = el.transform.baseVal.getItem(0).matrix;

            Object.assign(matrix, {
                a: this.labelScale,
                d: this.labelScale
            });
        }

    }

    transformScreenCTMtoCanvas(x, y) {
        const svg   = this.svgRoot;
        const ctm   = this.workflow.getScreenCTM();
        const point = svg.createSVGPoint();
        point.x     = x;
        point.y     = y;

        const t = point.matrixTransform(ctm.inverse());
        return {
            x: t.x,
            y: t.y
        };
    }

    deleteSelection() {

        const selection = Array.from(this.workflow.querySelectorAll(".selected"));
        if (selection.length == 0) {
            return;
        }

        const changeEventData = {
            type: "deletion",
            data: selection
        };
        this.eventHub.emit("beforeChange", changeEventData);

        selection.forEach(el => {
            if (el.classList.contains("step")) {

                this.model.removeStep(el.getAttribute("data-connection-id"));
                this.draw();
                (this.svgRoot as any).focus();
            } else if (el.classList.contains("edge")) {

                const sourcePortID      = el.getAttribute("data-source-connection");
                const destinationPortID = el.getAttribute("data-destination-connection");

                this.model.disconnect(sourcePortID, destinationPortID);
                this.draw();
                (this.svgRoot as any).focus();
            } else if (el.classList.contains("input")) {

                this.model.removeInput(el.getAttribute("data-connection-id"));
                this.draw();
                (this.svgRoot as any).focus();
            } else if (el.classList.contains("output")) {

                this.model.removeOutput(el.getAttribute("data-connection-id"));
                this.draw();
                (this.svgRoot as any).focus();
            }
        });

        this.eventHub.emit("selectionChange", null);

        this.eventHub.emit("afterChange", changeEventData);
    }


    enableEditing(enabled: boolean): void {
        this.invokePlugins("enableEditing", enabled);
    }

    // noinspection JSUnusedGlobalSymbols
    destroy() {

        this.svgRoot.classList.remove(this.svgID);

        this.clearCanvas();
        this.eventHub.empty();

        this.invokePlugins("destroy");

        for (const dispose of this.disposers) {
            dispose();
        }
    }

    resetTransform() {
        this.workflow.setAttribute("transform", "matrix(1,0,0,1,0,0)");
        this.scaleAtPoint();
    }


    private addEventListeners(): void {


        /**
         * Attach canvas panning
         */
        {
            let pane: SVGGElement;
            let x;
            let y;
            let matrix: SVGMatrix;
            this.domEvents.drag(".pan-handle", (dx, dy) => {

                matrix.e = x + dx;
                matrix.f = y + dy;

            }, (ev, el, root) => {
                pane   = root.querySelector(".workflow") as SVGGElement;
                matrix = pane.transform.baseVal.getItem(0).matrix;
                x      = matrix.e;
                y      = matrix.f;
            }, () => {
                pane   = undefined;
                matrix = undefined;
            });
        }

        /**
         * On mouse over node, bring it to the front
         */
        this.domEvents.on("mouseover", ".node", (ev, target, root) => {
            if (this.workflow.querySelector(".edge.dragged")) {
                return;
            }
            target.parentElement.appendChild(target);
        });

    }

    private attachSelectionDeletionBehavior() {
        this.handlersThatCanBeDisabled.push(this.domEvents.on("keyup", (ev: KeyboardEvent) => {

            if (!(ev.target instanceof SVGElement)) {
                return;
            }

            if (ev.which !== 8) {
                return;
            }

            this.deleteSelection();
            // Only input elements can be focused, but we added tabindex to the svg so this works
        }, window));
    }

    private clearCanvas() {
        this.domEvents.detachAll();
        this.workflow.innerHTML = "";
        this.workflow.setAttribute("transform", "matrix(1,0,0,1,0,0)");
        this.workflow.setAttribute("class", "workflow");
    }

    private hookPlugins() {

        this.plugins.forEach(plugin => {

            plugin.registerOnBeforeChange(event => {
                this.eventHub.emit("beforeChange", event);
            });

            plugin.registerOnAfterChange(event => {
                this.eventHub.emit("afterChange", event);
            });

            plugin.registerOnAfterRender(event => {
                this.eventHub.emit("afterRender", event);
            })
        });
    }

    private invokePlugins(methodName: keyof SVGPlugin, ...args: any[]) {
        this.plugins.forEach(plugin => {
            if (typeof plugin[methodName] === "function") {
                (plugin[methodName] as Function)(...args);
            }
        })
    }

    /**
     * Listener for “connection.create” event on model that renders new edges on canvas
     */
    private onConnectionCreate(source: Connectable, destination: Connectable): void {

        console.log("Connection cretion", source, destination);
        if (!source.isVisible || !destination.isVisible) {

            return;
        }

        const sourceID      = source.connectionId;
        const destinationID = destination.connectionId;

        GraphEdge.spawnBetweenConnectionIDs(this.workflow, sourceID, destinationID);

    }

    /**
     * Listener for “input.create” event on model that renders workflow inputs
     */
    private onInputCreate(input: WorkflowInputParameterModel): void {
        console.log("Input creation", input);
        if (!input.isVisible) {
            return;
        }

        const patched       = GraphNode.patchModelPorts(input);
        const graphTemplate = GraphNode.makeTemplate(patched, this.labelScale);

        const el = TemplateParser.parse(graphTemplate);
        this.workflow.appendChild(el);

    }

    /**
     * Listener for “output.create” event on model that renders workflow outputs
     */
    private onOutputCreate(output: WorkflowOutputParameterModel): void {

        if (!output.isVisible) {
            return;
        }

        const patched       = GraphNode.patchModelPorts(output);
        const graphTemplate = GraphNode.makeTemplate(patched, this.labelScale);

        const el = TemplateParser.parse(graphTemplate);
        this.workflow.appendChild(el);
    }

    private onStepCreate(step: StepModel) {

        if (!step.customProps["sbg:x"] && step.run.customProps && step.run.customProps["sbg:x"]) {

            Object.assign(step.customProps, {
                "sbg:x": step.run.customProps["sbg:x"],
                "sbg:y": step.run.customProps["sbg:y"]
            })
        }

        const template = GraphNode.makeTemplate(step, this.labelScale);
        const element  = TemplateParser.parse(template);
        this.workflow.appendChild(element);
    }


    private onStepChange(change: StepModel) {
        const title = this.workflow.querySelector(`.step[data-id="${change.connectionId}"] .title`) as SVGTextElement;
        if (title) {
            title.textContent = change.label;
        }
    }

    private onInputPortShow(input: WorkflowStepInputModel) {

        const stepEl = this.svgRoot.querySelector(`.step[data-connection-id="${input.parentStep.connectionId}"]`) as SVGElement;
        new StepNode(stepEl, input.parentStep).update();
    }

    private onInputPortHide(input: WorkflowStepInputModel) {
        const stepEl = this.svgRoot.querySelector(`.step[data-connection-id="${input.parentStep.connectionId}"]`) as SVGElement;
        new StepNode(stepEl, input.parentStep).update();
    }

    private makeID(length = 6) {
        let output    = "";
        const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

        for (let i = 0; i < length; i++) {
            output += charset.charAt(Math.floor(Math.random() * charset.length));
        }

        return output;
    }

}