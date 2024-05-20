options indenting = 4
options no_global_variables
options no_unused_function_arguments
options no_unused_block_arguments
options strict_smart_pointers
options no_aot

require ast
require completion_boost
require fio

let WRITE_RESULT = false
let WRITE_RESULT_TO_FILE = false

[export]
def main()
    var result <- CompletionContext()
    program_for_each_registered_module() <| $(mod)
        // print("{mod.name}\n")
        result |> parse_module(mod)

    let textRes = result.result |> to_json()
    if WRITE_RESULT_TO_FILE
        mkdir("results")
        fopen("results/completion.json", "w") <| $(f)
            f |> fwrite(textRes)

    if WRITE_RESULT
        textRes |> print()
