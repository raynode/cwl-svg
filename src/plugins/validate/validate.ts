import {Edge, WorkflowModel} from "cwlts/models";
import {PluginBase} from "../plugin-base";
import {Workflow} from "../../graph/workflow";

export class SVGValidatePlugin extends PluginBase {
    model: WorkflowModel;

    /** Map of CSS classes attached by this plugin */
    private classes = {
        plugin: "__plugin-validate",
        invalid: "__validate-invalid"
    };

    registerWorkflowModel(workflow: Workflow): void {
        super.registerWorkflowModel(workflow);
        this.model = workflow.model;

        // add listener for all subsequent edge validation
        this.model.on("connections.updated", () => {
            this.renderEdgeValidation();
        });

        // add plugin specific class to the svgRoot for scoping
        this.workflow.svgRoot.classList.add(this.classes.plugin);

    }

    afterRender(): void {
        // do initial validation rendering for edges
        this.renderEdgeValidation();
    }


    enableEditing(enabled: boolean): void {

        if (enabled) {
            // only show validation if workflow is editable
            this.renderEdgeValidation();
        } else {
            this.removeClasses(this.workflow.workflow.querySelectorAll(".edge"))
        }
    }

    private removeClasses(edges: NodeListOf<Element>) {
        // remove validity class on all edges
        for (const e of edges) {
            e.classList.remove(this.classes.invalid);
        }
    }

    private renderEdgeValidation() {
        const graphEdges = this.workflow.workflow.querySelectorAll(".edge") as NodeListOf<Element>;

        this.removeClasses(graphEdges);

        // iterate through all modal connections
        this.model.connections.forEach((e: Edge) => {
            // if the connection isn't valid (should be colored on graph)
            if (!e.isValid) {

                // iterate through edges on the svg
                for (const ge of graphEdges) {
                    const sourceNodeID      = ge.getAttribute("data-source-connection");
                    const destinationNodeID = ge.getAttribute("data-destination-connection");

                    // compare invalid edge source/destination with svg edge
                    if (e.source.id === sourceNodeID && e.destination.id === destinationNodeID) {
                        // if its a match, tag it with the appropriate class and break from the loop
                        ge.classList.add(this.classes.invalid);
                        break;
                    }
                }
            }
        });
    }
}