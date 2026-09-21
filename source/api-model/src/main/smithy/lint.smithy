$version: "2"

metadata validators = [
    {
        name: "EmitEachSelector"
        id: "OperationDocumentation"
        severity: "DANGER"
        message: "Every operation must explain its public HTTP behavior."
        configuration: { selector: "operation:not([trait|documentation])" }
    }
    {
        name: "UnreferencedShape"
        severity: "DANGER"
    }
]
